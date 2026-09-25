package com.seclettr.app;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.UUID;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

public class PushForegroundService extends Service {

    private static final String TAG = "SeclettrPush";
    private static final String CHANNEL_SERVICE = "seclettr_push_service";
    private static final String CHANNEL_MESSAGES = "seclettr_messages";
    private static final int NOTIF_SERVICE_ID = 1001;
    private static final int NOTIF_BASE_ID = 2000;
    private static final int MAX_RECONNECT_DELAY_MS = 30_000;
    private static final int INITIAL_RECONNECT_DELAY_MS = 1_000;

    private static final String PREFS_NAME = "seclettr_push_state";
    private static final String KEY_SERVER_URL = "serverUrl";
    private static final String KEY_TOKEN = "token";

    private static boolean running = false;

    private OkHttpClient httpClient;
    private WebSocket webSocket;
    private String serverUrl;
    private String token;
    private String wsUrl;
    private int reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    private boolean intentionalClose = false;
    private PowerManager.WakeLock wakeLock;
    private final android.os.Handler handler = new android.os.Handler(android.os.Looper.getMainLooper());

    public static boolean isRunning() {
        return running;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        Log.d(TAG, "PushForegroundService created");
        createNotificationChannels();
        acquireWakeLock();
    }

    /** Keep CPU awake so the WebSocket stays alive during screen-off / Doze. */
    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) return;
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm == null) return;
        wakeLock = pm.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "seclettr:push_ws_keepalive"
        );
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire(30 * 60 * 1000L); // 30 min max; re-acquired on each connectWebSocket()
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            Log.d(TAG, "Restarted by system with null intent — restoring state");
            restoreStateAndConnect();
            return START_STICKY;
        }

        String action = intent.getAction();
        if (action == null) return START_STICKY;

        switch (action) {
            case NativePushPlugin.ACTION_START:
                String newServerUrl = intent.getStringExtra("serverUrl");
                String newToken = intent.getStringExtra("token");
                if (newServerUrl == null || newToken == null) {
                    Log.w(TAG, "start missing serverUrl or token");
                    break;
                }
                serverUrl = newServerUrl;
                token = newToken;
                wsUrl = deriveWsUrl(serverUrl);
                saveState();
                startForeground(NOTIF_SERVICE_ID, buildServiceNotification());
                running = true;
                connectWebSocket();
                break;

            case NativePushPlugin.ACTION_STOP:
                intentionalClose = true;
                closeWebSocket();
                stopForeground(STOP_FOREGROUND_REMOVE);
                clearState();
                stopSelf();
                running = false;
                break;

            case NativePushPlugin.ACTION_UPDATE_TOKEN:
                String updatedToken = intent.getStringExtra("token");
                if (updatedToken == null) break;
                token = updatedToken;
                saveState();
                reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
                closeWebSocket();
                connectWebSocket();
                break;
        }

        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        Log.d(TAG, "PushForegroundService destroyed (intentional=" + intentionalClose + ")");
        if (!intentionalClose) {
            scheduleRestart();
        }
        closeWebSocket();
        running = false;
        releaseWakeLock();
        super.onDestroy();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        if (prefs.getBoolean("use_fcm", false)) {
            Log.d(TAG, "Task removed — FCM configured, skipping restart");
        } else {
            Log.d(TAG, "Task removed — scheduling restart");
            scheduleRestart();
        }
        super.onTaskRemoved(rootIntent);
    }

    private void scheduleRestart() {
        Intent restart = new Intent(this, PushForegroundService.class);
        PendingIntent pi = PendingIntent.getService(
            this, 0, restart,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
        if (am != null) {
            am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP,
                SystemClock.elapsedRealtime() + 1000, pi);
        }
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
            wakeLock = null;
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ── State persistence ─────────────────────────────────────────────────────

    private void saveState() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        prefs.edit()
            .putString(KEY_SERVER_URL, serverUrl)
            .putString(KEY_TOKEN, token)
            .apply();
    }

    private void clearState() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        prefs.edit().clear().apply();
    }

    private void restoreStateAndConnect() {
        if (running && webSocket != null) return;

        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);

        // If FCM was active before this process was killed, do not restart the
        // WS foreground service — FCM handles delivery without a persistent notification.
        if (prefs.getBoolean("use_fcm", false)) {
            Log.d(TAG, "FCM configured — skipping WS foreground service restore");
            stopSelf();
            return;
        }

        String savedServerUrl = prefs.getString(KEY_SERVER_URL, null);
        String savedToken = prefs.getString(KEY_TOKEN, null);

        if (savedServerUrl == null || savedToken == null) {
            Log.w(TAG, "No saved state to restore");
            stopSelf();
            return;
        }

        serverUrl = savedServerUrl;
        token = savedToken;
        wsUrl = deriveWsUrl(serverUrl);
        reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
        intentionalClose = false;

        startForeground(NOTIF_SERVICE_ID, buildServiceNotification());
        running = true;
        connectWebSocket();
    }

    // ── WebSocket ─────────────────────────────────────────────────────────────

    private void connectWebSocket() {
        if (wsUrl == null || token == null) {
            Log.w(TAG, "Cannot connect: wsUrl or token is null");
            return;
        }

        // refresh WakeLock on each connect attempt
        acquireWakeLock();

        if (httpClient == null) {
            httpClient = new OkHttpClient.Builder()
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .pingInterval(30, TimeUnit.SECONDS)
                .build();
        }

        // The access token must travel in the Authorization header. Passing it
        // via Sec-WebSocket-Protocol is rejected by the server outside dev
        // because that channel only accepts ws-scoped tickets (AUDIT.md H5).
        Request request = new Request.Builder()
            .url(wsUrl)
            .addHeader("Authorization", "Bearer " + token)
            .build();

        Log.d(TAG, "Connecting WebSocket: " + wsUrl);
        webSocket = httpClient.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket ws, Response response) {
                Log.d(TAG, "WebSocket connected");
                reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
            }

            @Override
            public void onMessage(WebSocket ws, String text) {
                handleWsMessage(text);
            }

            @Override
            public void onClosing(WebSocket ws, int code, String reason) {
                Log.d(TAG, "WebSocket closing: " + code + " " + reason);
                ws.close(code, reason);
            }

            @Override
            public void onClosed(WebSocket ws, int code, String reason) {
                Log.d(TAG, "WebSocket closed: " + code + " " + reason);
                webSocket = null;
                if (!intentionalClose) {
                    scheduleReconnect(code);
                }
            }

            @Override
            public void onFailure(WebSocket ws, Throwable t, Response response) {
                Log.w(TAG, "WebSocket failure: " + (t != null ? t.getMessage() : "unknown"), t);
                webSocket = null;
                if (!intentionalClose) {
                    int code = response != null ? response.code() : 0;
                    scheduleReconnect(code);
                }
            }
        });
    }

    private void closeWebSocket() {
        if (webSocket != null) {
            webSocket.close(1000, "Service stopping");
            webSocket = null;
        }
        handler.removeCallbacksAndMessages(null);
    }

    private void scheduleReconnect(int closeCode) {
        if (closeCode == 4001) {
            Log.w(TAG, "Auth failure (4001) — notifying JS layer for token refresh");
            notifyAuthFailure();
            handler.postDelayed(() -> {
                if (!intentionalClose && token != null) {
                    connectWebSocket();
                }
            }, 5_000);
            return;
        }

        int delay = reconnectDelay;
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
        long jitteredDelay = (long) (delay * (0.8 + Math.random() * 0.4));

        Log.d(TAG, "Reconnecting in " + jitteredDelay + "ms");
        handler.postDelayed(() -> {
            if (!intentionalClose) {
                connectWebSocket();
            }
        }, jitteredDelay);
    }

    // ── Message handling ──────────────────────────────────────────────────────

    private void handleWsMessage(String text) {
        try {
            JSONObject msg = new JSONObject(text);
            String type = msg.optString("type", "");

            switch (type) {
                case "plain_message.new":
                    handlePlainMessageNew(msg.optJSONObject("message"));
                    break;
                case "message.new":
                    handleEncryptedMessageNew(msg.optJSONObject("message"));
                    break;
                case "group_message.new":
                    handleEncryptedGroupMessageNew(msg);
                    break;
            }
        } catch (JSONException e) {
            Log.w(TAG, "Failed to parse WS message", e);
        }
    }

    // Derive a stable notification ID from the conversation key so IDs survive
    // process restarts without a persisted counter.  Range [10000, ~8M+10000]
    // avoids collision with NOTIF_SERVICE_ID (1001).
    private static int stableNotifId(String conversationKey) {
        return (conversationKey.hashCode() & 0x7FFFFF) + 10000;
    }

    private void handlePlainMessageNew(JSONObject message) {
        if (message == null) return;

        String senderUsername = message.optString("senderUsername", "Unknown");
        String messageContent = message.optString("content", "");
        String messageType = message.optString("messageType", "text");
        String groupId = message.optString("groupId", null);
        String senderUserId = message.optString("senderUserId", "");
        String messageId = message.optString("id", UUID.randomUUID().toString());

        String content = formatContent(messageContent, messageType);

        String conversationKey;
        String title;
        if (groupId != null && !groupId.isEmpty()) {
            conversationKey = "group:" + groupId;
            title = senderUsername + " (group)";
        } else {
            conversationKey = "dm:" + senderUserId;
            title = senderUsername;
        }

        int notifId = stableNotifId(conversationKey);

        String deepLinkPath;
        if (groupId != null && !groupId.isEmpty()) {
            deepLinkPath = "/?group=" + Uri.encode(groupId);
        } else {
            deepLinkPath = "/?chat=" + Uri.encode(senderUserId);
        }
        pushNotification(notifId, title, content, deepLinkPath);
    }

    private void handleEncryptedMessageNew(JSONObject message) {
        if (message == null) return;

        String senderUserId = message.optString("senderUserId", null);
        if (senderUserId == null) return;

        String conversationKey = "en:dm:" + senderUserId;
        int notifId = stableNotifId(conversationKey);
        pushNotification(notifId, "Seclettr", "New encrypted message", "/?chat=" + Uri.encode(senderUserId));
    }

    private void handleEncryptedGroupMessageNew(JSONObject msg) {
        String groupId = msg.optString("groupId", null);
        if (groupId == null) return;

        String conversationKey = "en:group:" + groupId;
        int notifId = stableNotifId(conversationKey);
        pushNotification(notifId, "Seclettr", "New encrypted group message", "/?group=" + Uri.encode(groupId));
    }

    private void pushNotification(int notifId, String title, String content, String deepLinkPath) {
        String deepLinkUrl = serverUrl.replaceFirst("/api/?$", "") + deepLinkPath;

        PendingIntent tapIntent = createNavigatePendingIntent(deepLinkUrl, notifId);
        PendingIntent replyIntent = createNavigatePendingIntent(deepLinkUrl, notifId + 1);
        PendingIntent markReadIntent = createNavigatePendingIntent(deepLinkUrl, notifId + 2);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat_notification)
            .setContentTitle(title)
            .setContentText(content)
            .setAutoCancel(true)
            .setContentIntent(tapIntent)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .addAction(R.drawable.ic_stat_notification, "Reply", replyIntent)
            .addAction(R.drawable.ic_stat_notification, "Mark as read", markReadIntent);

        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) {
            nm.notify(notifId, builder.build());
        }
    }

    private PendingIntent createNavigatePendingIntent(String deepLinkUrl, int requestCode) {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(deepLinkUrl));
        intent.setClass(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(
            this, requestCode, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private String deriveWsUrl(String apiUrl) {
        String wsProtocol = apiUrl.startsWith("https") ? "wss" : "ws";
        String stripped = apiUrl
            .replaceFirst("^https?://", "")
            .replaceFirst("/api/?$", "")
            .replaceFirst("/$", "");
        return wsProtocol + "://" + stripped + "/ws";
    }

    private String formatContent(String content, String messageType) {
        switch (messageType) {
            case "voice_note": return "Voice message";
            case "video_note": return "Video message";
            case "attachment": return "File";
            default: return content;
        }
    }

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;

        NotificationChannel serviceChannel = new NotificationChannel(
            CHANNEL_SERVICE, "Push Service", NotificationManager.IMPORTANCE_LOW);
        serviceChannel.setDescription("Ongoing notification for push message service");
        nm.createNotificationChannel(serviceChannel);

        NotificationChannel messagesChannel = new NotificationChannel(
            CHANNEL_MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH);
        messagesChannel.setDescription("New message notifications");
        messagesChannel.enableVibration(true);
        nm.createNotificationChannel(messagesChannel);

        NotificationChannel callsChannel = new NotificationChannel(
            "seclettr_calls", "Calls", NotificationManager.IMPORTANCE_HIGH);
        callsChannel.setDescription("Incoming call notifications");
        callsChannel.enableVibration(true);
        nm.createNotificationChannel(callsChannel);
    }

    private Notification buildServiceNotification() {
        Intent tapIntent = new Intent(this, MainActivity.class);
        tapIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        PendingIntent pendingIntent = PendingIntent.getActivity(
            this, 0, tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        return new NotificationCompat.Builder(this, CHANNEL_SERVICE)
            .setSmallIcon(R.drawable.ic_stat_notification)
            .setContentTitle("Seclettr")
            .setContentText("Push notifications active")
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
    }

    private void notifyAuthFailure() {
        NativePushPlugin plugin = NativePushPlugin.getActiveInstance();
        if (plugin != null) {
            NativePushPlugin.emitAuthFailure(plugin);
        }
    }
}
