import type { FastifyInstance } from "fastify";
import type { RawData } from "ws";
import { nanoid } from "nanoid";
import {
  safeParseWsClientMessage,
  type WsClientMessage,
  type WsServerMessage,
} from "@seclettr/protocol";
import {
  createRedisSubscriber,
  unregisterDeviceSocket,
  registerDeviceSocket,
  touchDeviceSocket,
  MESSAGE_CHANNEL,
  publishPresenceUpdate,
} from "./redis.js";
import { verifyWebSocketToken } from "./ws-auth.js";
import { parseRedisWsPayload } from "./ws-redis-payload.js";
import {
  forwardTypingSignal,
  markMessageDelivered,
  markMessageRead,
  replayMessageReceipts,
} from "./ws-message-events.js";
import {
  handleGroupCallMediaKeyAckSignal as routeGroupCallMediaKeyAckSignal,
  handleGroupCallMediaKeySignal as routeGroupCallMediaKeySignal,
  handleGroupCallMediaModeSignal as routeGroupCallMediaModeSignal,
  handleGroupCallProducerStateSignal as routeGroupCallProducerStateSignal,
  type GroupCallSignalDeps,
} from "./ws-group-call-signals.js";
import {
  hasDeviceScopedGroupCallParticipants,
  hasGroupCallParticipantDevice,
  hasGroupCallParticipantUser,
} from "./group-call-presence.js";
import {
  isAllowedGroupMemberDevice,
} from "./group-call-participant-routing.js";
import {
  ensureWebSocketRuntime,
  hasActiveConnectionForUserAcrossCluster,
  send,
  type ConnectedClient,
  type WebSocketRuntime,
} from "./ws-runtime.js";
import {
  createRoomLifecycleManager,
} from "./ws-room-lifecycle.js";
import {
  recordWebSocketConnected,
  recordWebSocketDisconnected,
} from "./observability.js";
import { query } from "../db/pool.js";

/* ── Signal runner (sequencer for stateful messages) ──────────────────────── */

function createSignalRunner() {
  let tail = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T> | T): Promise<T> => {
    const next = tail.then(() => task());
    tail = next.then(() => undefined, () => undefined);
    return next;
  };
  return { enqueue };
}

/* ── Low-level helpers ───────────────────────────────────────────────────── */

function sendToDeviceConnections(
  rt: WebSocketRuntime,
  deviceId: string,
  msg: WsServerMessage
): void {
  rt.connections.forEachByDevice(deviceId, (client) => {
    send(client.ws, msg);
  });
}

function sendToUserConnections(
  rt: WebSocketRuntime,
  userId: string,
  msg: WsServerMessage
): void {
  rt.connections.forEachByUser(userId, (client) => {
    send(client.ws, msg);
  });
}

function decodeTextFrame(rawData: RawData): string | null {
  if (typeof rawData === "string") return rawData;
  if (Buffer.isBuffer(rawData)) return rawData.toString("utf8");
  if (rawData instanceof ArrayBuffer)
    return Buffer.from(rawData).toString("utf8");
  if (Array.isArray(rawData)) {
    return Buffer.concat(
      rawData.map((chunk) =>
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      )
    ).toString("utf8");
  }
  return null;
}

/* ── Presence helpers ────────────────────────────────────────────────────── */

function broadcastPresenceLocally(
  rt: WebSocketRuntime,
  userId: string,
  online: boolean,
  lastSeenAt?: string
): void {
  const payload: WsServerMessage = {
    type: "presence.update",
    userId,
    online,
    lastSeenAt,
  };
  rt.connections.forEach((client) => {
    send(client.ws, payload);
  });
}

async function publishPresenceUpdateAcrossCluster(
  fastify: FastifyInstance,
  rt: WebSocketRuntime,
  userId: string,
  online: boolean,
  lastSeenAt?: string
): Promise<void> {
  try {
    await publishPresenceUpdate({
      type: "presence.update",
      userId,
      online,
      lastSeenAt,
    });
  } catch (err) {
    fastify.log.warn(
      { err, userId, online },
      "Failed to publish presence update over Redis"
    );
    broadcastPresenceLocally(rt, userId, online, lastSeenAt);
  }
}

async function touchDeviceLastSeen(
  deviceId: string,
  log: FastifyInstance["log"]
): Promise<void> {
  try {
    await query(
      `UPDATE devices
       SET last_seen_at = now()
       WHERE id = $1`,
      [deviceId]
    );
  } catch (err) {
    log.warn({ deviceId, err }, "[ws] touchDeviceLastSeen failed");
  }
}

/* ── Entrypoint ──────────────────────────────────────────────────────────── */

export async function registerWebSocketHandler(
  fastify: FastifyInstance
): Promise<void> {
  const rt = ensureWebSocketRuntime();
  const roomLifecycle = createRoomLifecycleManager();

  const subscriber = createRedisSubscriber();
  await subscriber.subscribe(MESSAGE_CHANNEL);

  subscriber.on("message", (_channel: string, rawPayload: string) => {
    try {
      const parsed = parseRedisWsPayload(rawPayload);
      if (!parsed) {
        return;
      }
      if (parsed.scope === "presence.broadcast") {
        broadcastPresenceLocally(
          rt,
          parsed.payload.userId,
          parsed.payload.online,
          parsed.payload.lastSeenAt
        );
      } else if (parsed.scope === "device.force_disconnect") {
        rt.connections.forEachByDevice(parsed.deviceId, (client) => {
          client.ws.close(4003, "Session terminated");
        });
      } else if (parsed.scope === "user") {
        sendToUserConnections(rt, parsed.recipientUserId, parsed.payload);
      } else {
        sendToDeviceConnections(rt, parsed.recipientDeviceId, parsed.payload);
      }
    } catch (err) {
      fastify.log.error({ err }, "Failed to process Redis message");
    }
  });

  fastify.addHook("onClose", async () => {
    rt.directCallSignalRouter.cancelAllDisconnectCleanup();
    try {
      await subscriber.unsubscribe(MESSAGE_CHANNEL);
    } catch (err) {
      fastify.log.warn({ err }, "Failed to unsubscribe WS redis subscriber");
    }
    try {
      await subscriber.quit();
    } catch {
      subscriber.disconnect();
    }
  });

  const groupCallSignalDeps: GroupCallSignalDeps = {
    getActiveRoomSession: (roomId) => roomLifecycle.getActiveRoomSession(roomId),
    hasDeviceScopedGroupCallParticipants,
    hasGroupCallParticipantDevice,
    hasGroupCallParticipantUser,
    isAllowedGroupMemberDevice,
    routeToDevice: (deviceId, message) => rt.routeToDevice(deviceId, message),
    publishGroupProducerStateEvent: (...args) =>
      roomLifecycle.publishGroupProducerStateEvent(...args),
    publishGroupMediaModeEvent: (...args) =>
      roomLifecycle.publishGroupMediaModeEvent(...args),
    sendWsMessage: send,
  };

  fastify.get("/ws", { websocket: true }, async (socket, request) => {
    let auth: { sub: string; deviceId: string; sessionId?: string } | null = null;
    try {
      auth = verifyWebSocketToken(fastify, request);
    } catch {
      socket.close(4001, "Unauthorized");
      return;
    }

    const socketId = nanoid();
    const client: ConnectedClient = {
      ws: socket,
      userId: auth.sub,
      deviceId: auth.deviceId,
      sessionId: auth.sessionId ?? null,
      socketId,
      joinedRoomIds: new Set<string>(),
    };
    rt.directCallSignalRouter.cancelDisconnectCleanup(client.deviceId);
    rt.connections.add(client);
    let pingInterval: NodeJS.Timeout | null = null;
    const signalRunner = createSignalRunner();

    const enqueueStatefulSignalTask = (
      task: () => Promise<void>,
      context: Record<string, unknown>,
      failureMessage: string
    ): void => {
      void signalRunner.enqueue(task).catch((err) => {
        fastify.log.warn(
          {
            err,
            socketId,
            userId: client.userId,
            deviceId: client.deviceId,
            ...context,
          },
          failureMessage
        );
      });
    };

    socket.on("message", (rawData, isBinary) => {
      if (isBinary) return;
      const text = decodeTextFrame(rawData);
      if (!text) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        send(client.ws, {
          type: "error",
          code: "MALFORMED_PAYLOAD",
          message: "Malformed websocket payload",
        });
        return;
      }

      const result = safeParseWsClientMessage(parsed);
      if (!result.success) {
        send(client.ws, {
          type: "error",
          code: result.error.code,
          message:
            result.error.code === "UNSUPPORTED_PROTOCOL_VERSION"
              ? `Unsupported websocket protocol version ${String(
                  result.error.receivedVersion ?? "unknown"
                )}`
              : "Invalid websocket payload",
        });

        if (result.error.code === "UNSUPPORTED_PROTOCOL_VERSION") {
          socket.close(1002, "Unsupported websocket protocol version");
        }
        return;
      }
      const msg: WsClientMessage = result.data;

      if (!rt.wsRateLimiter.consume(socketId, msg.type)) {
        const callId = "callId" in msg ? msg.callId : undefined;
        fastify.log.debug(
          {
            socketId,
            userId: client.userId,
            deviceId: client.deviceId,
            messageType: msg.type,
            callId,
          },
          "WS message rate-limited"
        );
        send(client.ws, {
          type: "error",
          code: "RATE_LIMITED",
          message: "Too many messages",
        });
        return;
      }

      switch (msg.type) {
        case "ping":
          send(client.ws, { type: "pong", id: msg.id });
          break;

        case "ack":
          void markMessageDelivered(fastify, msg.messageId, client.deviceId);
          break;

        case "message.read":
          void markMessageRead(
            fastify,
            msg.messageId,
            client.deviceId,
            client.userId
          );
          break;

        case "typing.start":
        case "typing.stop":
          void forwardTypingSignal(
            fastify,
            client,
            msg.targetUserId,
            msg.type,
            (msg as { chatKind?: "plain" | "e2ee" }).chatKind
          );
          break;

        case "call.offer":
        case "call.answer":
        case "call.renegotiate.offer":
        case "call.renegotiate.answer":
        case "call.ice":
        case "call.ice.batch":
        case "call.hangup":
        case "call.media_state":
        case "call.reject":
          enqueueStatefulSignalTask(
            () =>
              rt.directCallSignalRouter.handleSignal(
                fastify,
                client,
                msg as WsClientMessage & { callId: string }
              ),
            { callId: msg.callId, type: msg.type },
            "Failed to route call signal"
          );
          break;

        case "group.call.media-key":
          enqueueStatefulSignalTask(
            () => routeGroupCallMediaKeySignal(groupCallSignalDeps, fastify, client, msg),
            {
              callId: msg.callId,
              targetDeviceId: msg.targetDeviceId,
              type: msg.type,
            },
            "Failed to route group call media key"
          );
          break;

        case "group.call.media-key.ack":
          enqueueStatefulSignalTask(
            () => routeGroupCallMediaKeyAckSignal(groupCallSignalDeps, fastify, client, msg),
            {
              callId: msg.callId,
              targetDeviceId: msg.targetDeviceId,
              type: msg.type,
            },
            "Failed to route group call media key ack"
          );
          break;

        case "group.call.media-mode":
          enqueueStatefulSignalTask(
            () => routeGroupCallMediaModeSignal(groupCallSignalDeps, fastify, client, msg),
            { callId: msg.callId, mode: msg.mode, type: msg.type },
            "Failed to route group call media mode"
          );
          break;

        case "group.call.producer_state":
          enqueueStatefulSignalTask(
            () => routeGroupCallProducerStateSignal(groupCallSignalDeps, fastify, client, msg),
            {
              callId: msg.callId,
              producerId: msg.producerId,
              kind: msg.kind,
              state: msg.state,
            },
            "Failed to route group call producer state"
          );
          break;

        case "room.join":
        case "room.leave":
          enqueueStatefulSignalTask(
            () => roomLifecycle.handleRoomSignal(fastify, client, msg),
            { roomId: msg.roomId, type: msg.type },
            "Failed to process room signal"
          );
          break;
      }
    });

    socket.on("close", async () => {
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
      }
      recordWebSocketDisconnected();
      rt.connections.remove(client.socketId);
      rt.wsRateLimiter.clear(socketId);
      await roomLifecycle.cleanupJoinedRoomsOnDisconnect(fastify, client);
      await unregisterDeviceSocket(client.userId, client.deviceId, socketId);
      await touchDeviceLastSeen(client.deviceId, fastify.log);
      rt.directCallSignalRouter.scheduleDisconnectCleanup(fastify, client);
      if (!(await hasActiveConnectionForUserAcrossCluster(client.userId))) {
        await publishPresenceUpdateAcrossCluster(
          fastify,
          rt,
          client.userId,
          false,
          new Date().toISOString()
        );
      }
      fastify.log.info({ userId: client.userId }, "WS disconnected");
    });

    socket.on("error", (err) => {
      fastify.log.error({ err, userId: client.userId }, "WS error");
    });

    await registerDeviceSocket(auth.sub, auth.deviceId, socketId);
    recordWebSocketConnected();
    await touchDeviceLastSeen(auth.deviceId, fastify.log);
    await publishPresenceUpdateAcrossCluster(fastify, rt, auth.sub, true);
    void replayMessageReceipts(fastify, auth.deviceId);
    void rt.directCallSignalRouter
      .replayPendingOffers(fastify, client)
      .catch((err) => {
        fastify.log.warn(
          { err, userId: auth.sub, deviceId: auth.deviceId },
          "Failed to replay pending direct-call offers after reconnect"
        );
      });

    fastify.log.info(
      { userId: auth.sub, deviceId: auth.deviceId },
      "WS connected"
    );

    pingInterval = setInterval(() => {
      if (socket.readyState === socket.OPEN) {
        socket.ping();
        void touchDeviceSocket(client.userId, client.deviceId).catch((err) => {
          fastify.log.warn({ err, deviceId: client.deviceId }, "Failed to refresh device socket TTL");
        });
      }
    }, 30_000);
  });
}

export { hasActiveConnectionForUserAcrossCluster } from "./ws-runtime.js";
