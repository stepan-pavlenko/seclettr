import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "@/lib/api";
import type { RoomJoinPreviewResponse, RoomJoinResponse } from "@seclettr/protocol";
import type { RoomCallSession } from "@/calls/room/room-call-bootstrap";
import styles from "./RoomJoinPage.module.css";

const RoomCallPanel = lazy(() =>
  import("@/calls/room/RoomCallPanel").then(({ RoomCallPanel: Component }) => ({ default: Component }))
);

type PageState =
  | { phase: "loading" }
  | { phase: "preview"; preview: RoomJoinPreviewResponse }
  | { phase: "joining" }
  | { phase: "in-call"; session: RoomCallSession }
  | { phase: "error"; message: string }
  | { phase: "left" };

const GUEST_NAME_MAX = 64;

export function RoomJoinPage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<PageState>({ phase: "loading" });
  const [guestName, setGuestName] = useState("");
  const hasLoadedPreview = useRef(false);

  useEffect(() => {
    if (hasLoadedPreview.current || !token) return;
    hasLoadedPreview.current = true;

    api.getRoomPreview(token).then(
      (preview) => setState({ phase: "preview", preview }),
      (err) => {
        const message = err instanceof Error ? err.message : "Room not found or link has expired.";
        setState({ phase: "error", message });
      }
    );
  }, [token]);

  const handleJoin = async () => {
    if (!token || state.phase !== "preview") return;
    const name = guestName.trim();
    if (!name) return;

    setState({ phase: "joining" });

    try {
      const joinRes: RoomJoinResponse = await api.redeemRoomInvite(token, { guestName: name });

      const session: RoomCallSession = {
        callId: joinRes.callId,
        callType: joinRes.callType,
        participantId: joinRes.guestSessionId,
        deviceId: joinRes.guestSessionId,
        displayName: name,
        isGuest: true,
        isHost: false,
        guestToken: joinRes.guestToken,
        // Fall back to the client's runtime-resolved /sfu when the server does
        // not expose a browser-reachable public SFU URL (the default).
        sfuBaseUrl: joinRes.sfuUrl ?? null,
        inviteUrl: null,
      };

      setState({ phase: "in-call", session });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to join room.";
      setState({ phase: "error", message });
    }
  };

  if (state.phase === "loading") {
    return (
      <div className={styles.page}>
        <p className={styles.stateText}>Loading room info…</p>
      </div>
    );
  }

  if (state.phase === "error") {
    return (
      <div className={styles.page}>
        <div className={styles.content}>
          <h2 className={styles.errorTitle}>Room unavailable</h2>
          <p className={styles.errorText}>{state.message}</p>
        </div>
      </div>
    );
  }

  if (state.phase === "left") {
    return (
      <div className={styles.page}>
        <h2 className={styles.errorTitle}>You have left the room.</h2>
      </div>
    );
  }

  if (state.phase === "in-call") {
    return (
      <div className={styles.callRoot}>
        <Suspense fallback={<p className={styles.stateText}>Loading room call…</p>}>
          <RoomCallPanel
            session={state.session}
            onLeave={() => setState({ phase: "left" })}
          />
        </Suspense>
      </div>
    );
  }

  const preview = state.phase === "preview" ? state.preview : null;
  const isJoining = state.phase === "joining";

  return (
    <div className={styles.page}>
      <div className={styles.content}>
        <h2 className={styles.title}>
          {preview?.hostUsername ? `${preview.hostUsername}'s room` : "Room call"}
        </h2>
        <p className={styles.subtitle}>
          {preview?.callType === "video" ? "Video call" : "Audio call"}
          {preview?.expiresAt ? ` · expires ${new Date(preview.expiresAt).toLocaleString()}` : ""}
        </p>

        <label htmlFor="guest-display-name" className={styles.label}>
          Your display name
        </label>
        <input
          id="guest-display-name"
          type="text"
          value={guestName}
          onChange={(e) => setGuestName(e.target.value.slice(0, GUEST_NAME_MAX))}
          placeholder="Enter your name"
          maxLength={GUEST_NAME_MAX}
          disabled={isJoining}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleJoin();
          }}
          className={styles.input}
          autoFocus
        />

        <button
          type="button"
          onClick={() => void handleJoin()}
          disabled={isJoining || guestName.trim().length === 0}
          className={styles.joinButton}
        >
          {isJoining ? "Joining…" : "Join room"}
        </button>
      </div>
    </div>
  );
}
