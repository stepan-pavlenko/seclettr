/**
 * frame-key-store — manages remote frame key contexts and applies them to active consumers.
 *
 * Owns:
 *   - remoteFrameKeyContextsByDeviceId map
 *   - setRemoteMediaKey — merges new key contexts and pushes to relevant consumers
 *
 * Does not own consumer lifecycle, crypto handle lifecycle (handles are owned by ConsumerManager).
 */
import type { ReceivedGroupCallMediaKey } from "@/calls/group/runtime/media-key/media-key";
import {
  logGroupCallInfo,
} from "@/calls/group/runtime/media-key/logger";
import type { GroupCallFrameCryptoHandle } from "@/calls/shared/crypto/frame-crypto";
import {
  mergeRemoteFrameKeyContexts,
  toFrameKeyContext,
} from "./runtime-common";
import type { ManagedConsumer } from "./types";

export interface FrameKeyStoreOptions {
  roomId: string;
  frameCryptoEnabled: boolean;
}

export function createFrameKeyStore(options: FrameKeyStoreOptions) {
  const remoteFrameKeyContextsByDeviceId = new Map<string, ReturnType<typeof mergeRemoteFrameKeyContexts>>();

  const setRemoteMediaKey = (
    senderDeviceId: string,
    mediaKey: ReceivedGroupCallMediaKey | null,
    consumersByProducerId: Map<string, ManagedConsumer>,
    remoteFrameCryptoByProducerId: Map<string, GroupCallFrameCryptoHandle>,
  ) => {
    if (!options.frameCryptoEnabled || !senderDeviceId) return;

    const nextKeyContexts = mergeRemoteFrameKeyContexts(
      remoteFrameKeyContextsByDeviceId.get(senderDeviceId),
      mediaKey ? toFrameKeyContext(mediaKey) : null,
    );
    if (nextKeyContexts.length > 0) {
      remoteFrameKeyContextsByDeviceId.set(senderDeviceId, nextKeyContexts);
    } else {
      remoteFrameKeyContextsByDeviceId.delete(senderDeviceId);
    }

    for (const managed of consumersByProducerId.values()) {
      if (managed.deviceId !== senderDeviceId) continue;
      remoteFrameCryptoByProducerId.get(managed.producerId)?.setKeyContexts(nextKeyContexts);
    }
    logGroupCallInfo("[group-call] remote media key applied", {
      roomId: options.roomId,
      senderDeviceId,
      keyId: mediaKey?.keyId,
    });
  };

  const getContextsForDevice = (deviceId: string) =>
    remoteFrameKeyContextsByDeviceId.get(deviceId) ?? [];

  // Zero raw key bytes before dropping contexts so media key material does not
  // linger in the heap after the call ends (AUDIT.md H8).
  const zeroize = () => {
    for (const contexts of remoteFrameKeyContextsByDeviceId.values()) {
      for (const context of contexts) {
        context.keyBytes.fill(0);
      }
    }
    remoteFrameKeyContextsByDeviceId.clear();
  };

  return {
    remoteFrameKeyContextsByDeviceId,
    setRemoteMediaKey,
    getContextsForDevice,
    zeroize,
  };
}
