/**
 * useGroupCallInboundAckVerification — subscribes to incoming group.call.media-key.ack
 * signals, verifies the ACK proof, and marks targets as confirmed.
 */
import { useEffect, useRef, type MutableRefObject } from "react";
import { verifyMediaKeyAckProof } from "@/calls/group/runtime/media-key/media-key-ack-proof";
import { logGroupCallWarn } from "@/calls/group/runtime/media-key/logger";
import { wsClient } from "@/lib/websocket";
import type { GroupCallMediaKeyDeliveryTracker } from "@/calls/group/runtime/media-key/media-key-delivery";
import type { LocalGroupCallMediaKey } from "@/calls/group/runtime/media-key/media-key";

interface Params {
  callId: string | null;
  deviceId: string | null;
  effectiveFrameEncryptionEnabled: boolean;
  localMediaKeyRef: MutableRefObject<LocalGroupCallMediaKey | null>;
  mediaKeyDeliveryTrackerRef: MutableRefObject<GroupCallMediaKeyDeliveryTracker | null>;
  sharedMediaKeyTargetsRef: MutableRefObject<Set<string>>;
  setSharedMediaKeyDeviceCount: (count: number) => void;
}

export function useGroupCallInboundAckVerification(params: Params) {
  const paramsRef = useRef(params);
  paramsRef.current = params;

  useEffect(() => {
    const {
      callId,
      deviceId,
      effectiveFrameEncryptionEnabled,
    } = paramsRef.current;

    if (!effectiveFrameEncryptionEnabled || !callId || !deviceId) {
      return;
    }

    let active = true;

    const unsubscribe = wsClient.on((msg) => {
      if (!active) return;
      if (msg.type !== "group.call.media-key.ack") return;
      if (msg.callId !== callId || msg.targetDeviceId !== deviceId) return;

      const p = paramsRef.current;
      const tracker = p.mediaKeyDeliveryTrackerRef.current;
      if (!tracker) return;

      const localKey = p.localMediaKeyRef.current;
      if (!localKey || localKey.keyId !== msg.keyId) {
        // No matching local key: we never sent this key, so the ACK cannot be
        // authentic. Never verify against a zero key (see AUDIT.md H7).
        logGroupCallWarn("[gc] media-key.ack for unknown keyId, ignoring", {
          callId,
          senderDeviceId: msg.senderDeviceId,
          keyId: msg.keyId,
        });
        return;
      }

      verifyMediaKeyAckProof(localKey.keyBytes, msg.keyId, msg.epoch, msg.keyProof)
        .then((valid) => {
          if (!active) return;
          if (!valid) {
            logGroupCallWarn("[gc] media-key.ack proof invalid, ignoring", {
              callId,
              senderDeviceId: msg.senderDeviceId,
              keyId: msg.keyId,
            });
            return;
          }
          const acknowledgedDeviceId = tracker.acknowledge(msg);
          if (!acknowledgedDeviceId) return;
          if (p.sharedMediaKeyTargetsRef.current.has(acknowledgedDeviceId)) return;

          p.sharedMediaKeyTargetsRef.current.add(acknowledgedDeviceId);
          p.setSharedMediaKeyDeviceCount(p.sharedMediaKeyTargetsRef.current.size);
        })
        .catch(() => {
        });
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [params.callId, params.deviceId, params.effectiveFrameEncryptionEnabled]);
}
