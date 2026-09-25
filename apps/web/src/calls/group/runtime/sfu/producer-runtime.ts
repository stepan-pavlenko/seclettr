/**
 * producer-runtime — local media producer lifecycle manager for group calls.
 *
 * Owns:
 *   - createSfuProducerRuntime — factory that returns GroupSfuProducerRuntime
 *   - GroupSfuProducerRuntime interface (initializeLocalProducers, setVideoTrack,
 *     setAudioTrack, setLocalMediaKey, getLocalProducerIds, getDebugSnapshot, close)
 *   - Audio and per-source video producer creation via the mediasoup send transport
 *   - Sender-side frame-encryption handle lifecycle: bind on produce, update on
 *     key change, close on track removal
 *   - Bitrate encoding caps: CAMERA_MAX_BITRATE (1.5 Mbps), SCREEN_SHARE_MAX_BITRATE (2.5 Mbps)
 *   - Remote producer teardown via sfuHttpClient.closeProducer (best-effort)
 *
 * Does not own the send transport setup (see group-call-sfu-client.ts), the SFU
 * HTTP client (see http-client.ts), or consumer-side decryption (see consumer-runtime.ts).
 */
import type { SfuProducerSource } from "@seclettr/protocol";
import { type types as MediasoupTypes } from "mediasoup-client";
import {
  bindSenderFrameEncryption,
  type GroupCallFrameCryptoHandle,
} from "@/calls/shared/crypto/frame-crypto";
import type { LocalGroupCallMediaKey } from "@/calls/group/runtime/media-key/media-key";
import {
  logGroupCallInfo,
  logGroupCallWarn,
} from "@/calls/group/runtime/media-key/logger";
import type { SfuHttpClient } from "./http-client";
import { snapshotMediaTrack, toFrameKeyContext } from "./runtime-common";
import type {
  GroupCallMediaEncryptionMode,
  MediaKind,
  SendTransport,
} from "./types";

interface CreateSfuProducerRuntimeOptions {
  roomId: string;
  deviceId: string;
  localStream: MediaStream;
  sendTransport: SendTransport;
  canProduceVideo: boolean;
  mediaEncryptionMode: GroupCallMediaEncryptionMode;
  initialLocalMediaKey?: LocalGroupCallMediaKey | null;
  sfuHttpClient: Pick<SfuHttpClient, "closeProducer">;
  announceProducerState: (
    producerId: string,
    kind: MediaKind,
    state: "added" | "removed",
    source?: SfuProducerSource
  ) => void;
}

export interface GroupSfuProducerRuntime {
  initializeLocalProducers: () => Promise<void>;
  setVideoTrack: (track: MediaStreamTrack | null, source?: SfuProducerSource) => Promise<void>;
  setAudioTrack: (track: MediaStreamTrack) => Promise<void>;
  setLocalMediaKey: (mediaKey: LocalGroupCallMediaKey | null) => void;
  getLocalProducerIds: () => Set<string>;
  getDebugSnapshot: () => Record<string, unknown>;
  close: () => void;
}

/** Max bitrate for camera video at 720p (bits/s). */
const CAMERA_MAX_BITRATE = 1_500_000;
/** Max bitrate for screen-share video (bits/s). Higher than camera for text clarity. */
const SCREEN_SHARE_MAX_BITRATE = 2_500_000;

export function createSfuProducerRuntime(
  options: CreateSfuProducerRuntimeOptions
): GroupSfuProducerRuntime {
  const frameCryptoEnabled = options.mediaEncryptionMode !== "off";
  const frameCryptoRequired = options.mediaEncryptionMode === "required";
  let localAudioProducer: MediasoupTypes.Producer | null = null;
  const localVideoProducers = new Map<SfuProducerSource, MediasoupTypes.Producer>();
  const localFrameCryptoHandles = new Map<string, GroupCallFrameCryptoHandle>();
  let localFrameKeyContext = options.initialLocalMediaKey
    ? toFrameKeyContext(options.initialLocalMediaKey)
    : null;
  let closed = false;

  const closeLocalProducerRemotely = (
    producerId: string,
    source?: SfuProducerSource
  ) => {
    options.sfuHttpClient.closeProducer(producerId, {
      roomId: options.roomId,
    }).catch((error) => {
      logGroupCallWarn("[group-call] failed to close remote video producer", {
        producerId,
        source: source ?? null,
        error,
      });
    });
  };

  const closeLocalFrameHandle = (slot: string) => {
    localFrameCryptoHandles.get(slot)?.close();
    localFrameCryptoHandles.delete(slot);
  };

  const bindLocalFrameCrypto = (
    slot: string,
    rtpSender: RTCRtpSender,
    context: {
      kind: "audio" | "video";
      source?: SfuProducerSource;
    }
  ) => {
    if (!frameCryptoEnabled) {
      return;
    }

    closeLocalFrameHandle(slot);
    const frameCryptoHandle = bindSenderFrameEncryption(
      rtpSender,
      {
        roomId: options.roomId,
        deviceId: options.deviceId,
        kind: context.kind,
        source: context.source,
      },
      localFrameKeyContext ? [localFrameKeyContext] : null,
      () => {
        logGroupCallWarn("[sfu] sender frame-crypto pipeline failed", {
          roomId: options.roomId,
          slot,
          kind: context.kind,
        });
      },
      // In required mode never transmit plaintext frames while the UI reports
      // E2EE; frames are dropped until a key is armed (see AUDIT.md C4).
      frameCryptoRequired
    );
    if (frameCryptoRequired && !frameCryptoHandle.supported) {
      frameCryptoHandle.close();
      throw new Error("Group call frame encryption is required but unsupported by this browser");
    }
    if (frameCryptoRequired && !localFrameKeyContext) {
      frameCryptoHandle.close();
      throw new Error("Group call frame encryption is required but no media key is armed");
    }
    localFrameCryptoHandles.set(slot, frameCryptoHandle);
    logGroupCallInfo("[group-call] sender frame transform attached", {
      roomId: options.roomId,
      deviceId: options.deviceId,
      kind: context.kind,
      source: context.source ?? null,
      supported: frameCryptoHandle.supported,
      epoch: localFrameKeyContext?.epoch ?? null,
      keyId: localFrameKeyContext?.keyId ?? null,
    });
  };

  const initializeLocalAudioProducer = async () => {
    if (closed || localAudioProducer) {
      return;
    }
    const localAudioTrack = options.localStream.getAudioTracks()[0] ?? null;
    if (!localAudioTrack) {
      return;
    }

    const producerHandle = await options.sendTransport.produce({
      track: localAudioTrack,
      onRtpSender: (rtpSender) => {
        bindLocalFrameCrypto("audio", rtpSender, { kind: "audio" });
      },
    });
    localAudioProducer = producerHandle;
    options.announceProducerState(producerHandle.id, "audio", "added");
  };

  const setVideoTrack = async (
    track: MediaStreamTrack | null,
    source: SfuProducerSource = "camera"
  ): Promise<void> => {
    const currentProducer = localVideoProducers.get(source);
    if (currentProducer) {
      options.announceProducerState(currentProducer.id, "video", "removed", source);
      closeLocalFrameHandle(`video:${source}`);
      closeLocalProducerRemotely(currentProducer.id, source);
      currentProducer.close();
      localVideoProducers.delete(source);
    }

    if (!track || closed) {
      return;
    }

    if (!options.canProduceVideo) {
      throw new Error("This device cannot produce video");
    }

    const producerHandle = await options.sendTransport.produce({
      track,
      appData: { source },
      encodings: [{ maxBitrate: source === "screen" ? SCREEN_SHARE_MAX_BITRATE : CAMERA_MAX_BITRATE }],
      onRtpSender: (rtpSender) => {
        bindLocalFrameCrypto(`video:${source}`, rtpSender, {
          kind: "video",
          source,
        });
      },
    });
    localVideoProducers.set(source, producerHandle);
    options.announceProducerState(producerHandle.id, "video", "added", source);
  };

  const setAudioTrack = async (track: MediaStreamTrack): Promise<void> => {
    if (!localAudioProducer || closed) return;
    await localAudioProducer.replaceTrack({ track });
  };

  return {
    initializeLocalProducers: async () => {
      await initializeLocalAudioProducer();
      const localVideoTrack = options.localStream.getVideoTracks()[0] ?? null;
      if (localVideoTrack) {
        await setVideoTrack(localVideoTrack);
      }
    },
    setVideoTrack,
    setAudioTrack,
    setLocalMediaKey: (mediaKey) => {
      if (!frameCryptoEnabled) {
        return;
      }
      localFrameKeyContext = mediaKey ? toFrameKeyContext(mediaKey) : null;
      for (const handle of localFrameCryptoHandles.values()) {
        handle.setKeyContexts(localFrameKeyContext ? [localFrameKeyContext] : []);
      }
      logGroupCallInfo("[group-call] local media key applied", {
        roomId: options.roomId,
        deviceId: options.deviceId,
        epoch: localFrameKeyContext?.epoch ?? null,
        keyId: localFrameKeyContext?.keyId ?? null,
        armed: Boolean(localFrameKeyContext),
      });
    },
    getLocalProducerIds: () => {
      const producerIds = new Set<string>();
      if (localAudioProducer) {
        producerIds.add(localAudioProducer.id);
      }
      for (const producer of localVideoProducers.values()) {
        producerIds.add(producer.id);
      }
      return producerIds;
    },
    getDebugSnapshot: () => ({
      localFrameKeyArmed: Boolean(localFrameKeyContext),
      localFrameKeyContext: localFrameKeyContext
        ? {
            keyId: localFrameKeyContext.keyId,
            epoch: localFrameKeyContext.epoch,
          }
        : null,
      localAudioProducer: localAudioProducer
        ? {
            id: localAudioProducer.id,
            paused: localAudioProducer.paused,
            closed: localAudioProducer.closed,
            track: snapshotMediaTrack(localAudioProducer.track ?? null),
          }
        : null,
      localVideoProducers: [...localVideoProducers.entries()].map(([source, producer]) => ({
        source,
        id: producer.id,
        paused: producer.paused,
        closed: producer.closed,
        track: snapshotMediaTrack(producer.track ?? null),
      })),
      localFrameCryptoHandles: [...localFrameCryptoHandles.entries()].map(([slot, handle]) => ({
        slot,
        supported: handle.supported,
      })),
    }),
    close: () => {
      if (closed) {
        return;
      }
      closed = true;

      if (localAudioProducer) {
        options.announceProducerState(localAudioProducer.id, "audio", "removed");
        closeLocalProducerRemotely(localAudioProducer.id);
        localAudioProducer.close();
        localAudioProducer = null;
      }

      for (const [source, producer] of localVideoProducers.entries()) {
        options.announceProducerState(producer.id, "video", "removed", source);
        closeLocalProducerRemotely(producer.id, source);
        producer.close();
      }
      localVideoProducers.clear();

      for (const handle of localFrameCryptoHandles.values()) {
        handle.close();
      }
      localFrameCryptoHandles.clear();
    },
  };
}
