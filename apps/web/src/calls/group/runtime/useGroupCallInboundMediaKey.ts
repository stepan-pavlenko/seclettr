/**
 * useGroupCallInboundMediaKey — subscribes to incoming group.call.media-key signals,
 * decrypts them, stores the received key, and sends a group.call.media-key.ack.
 */
import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { KeyPair } from "@seclettr/crypto";
import type { ReceivedGroupCallMediaKey } from "@/calls/group/runtime/media-key/media-key";
import {
  decryptGroupCallMediaKeyFromSignal,
  shouldReplaceReceivedGroupCallMediaKey,
} from "@/calls/group/runtime/media-key/media-key";
import { computeMediaKeyAckProof } from "@/calls/group/runtime/media-key/media-key-ack-proof";
import { logGroupCallInfo, logGroupCallWarn } from "@/calls/group/runtime/media-key/logger";
import { wsClient } from "@/lib/websocket";
import type { GroupSfuClient } from "@/calls/group/runtime/sfu";

interface Params {
  callId: string | null;
  deviceId: string | null;
  effectiveFrameEncryptionEnabled: boolean;
  identityDhKeyPair: KeyPair | null;
  receivedMediaKeysRef: MutableRefObject<Record<string, ReceivedGroupCallMediaKey>>;
  setReceivedMediaKeyCount: Dispatch<SetStateAction<number>>;
  sfuClientRef: MutableRefObject<GroupSfuClient | null>;
}

export function useGroupCallInboundMediaKey(params: Params) {
  const paramsRef = useRef(params);
  paramsRef.current = params;

  useEffect(() => {
    const {
      callId,
      deviceId,
      effectiveFrameEncryptionEnabled,
      identityDhKeyPair,
    } = paramsRef.current;

    if (!effectiveFrameEncryptionEnabled || !callId || !identityDhKeyPair || !deviceId) {
      return;
    }

    let cancelled = false;

    const unsubscribe = wsClient.on((msg) => {
      if (msg.type !== "group.call.media-key") return;
      if (msg.callId !== callId || msg.targetDeviceId !== deviceId) return;

      decryptGroupCallMediaKeyFromSignal(msg, identityDhKeyPair)
        .then((decrypted) => {
          if (cancelled) return;

          const p = paramsRef.current;
          const current = p.receivedMediaKeysRef.current[decrypted.senderDeviceId];
          if (!shouldReplaceReceivedGroupCallMediaKey(current, decrypted)) {
            return;
          }

          p.receivedMediaKeysRef.current = {
            ...p.receivedMediaKeysRef.current,
            [decrypted.senderDeviceId]: decrypted,
          };
          p.sfuClientRef.current?.setRemoteMediaKey(decrypted.senderDeviceId, decrypted);
          p.setReceivedMediaKeyCount(Object.keys(p.receivedMediaKeysRef.current).length);
          logGroupCallInfo("[gc] media-key accepted", {
            callId,
            senderUserId: decrypted.senderUserId,
            senderDeviceId: decrypted.senderDeviceId,
            epoch: decrypted.epoch,
            keyId: decrypted.keyId,
          });

          computeMediaKeyAckProof(decrypted.keyBytes, decrypted.keyId, decrypted.epoch)
            .then((keyProof) => {
              if (cancelled) return;
              wsClient.send(
                {
                  type: "group.call.media-key.ack",
                  callId,
                  targetDeviceId: decrypted.senderDeviceId,
                  epoch: decrypted.epoch,
                  keyId: decrypted.keyId,
                  keyProof,
                },
                {
                  queueIfDisconnected: true,
                  queueKey: `group.call.media-key.ack:${callId}:${decrypted.senderDeviceId}:${decrypted.keyId}`,
                  ttlMs: 15_000,
                }
              );
            })
            .catch((proofError) => {
              // The proof is mandatory (see AUDIT.md H7); sending an ACK
              // without it would be rejected by the sender anyway.
              if (cancelled) return;
              logGroupCallWarn("[gc] media-key ack proof computation failed; ack not sent", proofError);
            });
        })
        .catch((decryptError) => {
          if (cancelled) return;
          logGroupCallWarn("[gc] media-key decrypt failed", decryptError);
        });
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [params.callId, params.deviceId, params.effectiveFrameEncryptionEnabled, params.identityDhKeyPair]);
}
