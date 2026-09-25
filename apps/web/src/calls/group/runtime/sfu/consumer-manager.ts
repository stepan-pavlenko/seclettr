/**
 * consumer-manager — SFU consumer lifecycle management.
 *
 * Owns:
 *   - Consumer creation via SFU HTTP consume + mediasoup transport.consume
 *   - Frame-decryption handle binding per consumer
 *   - Consumer teardown (cleanup + emit)
 *   - Producer grace period for rapid add/remove cycles
 *   - Consume retry state for failed operations
 *   - pruneInvisibleProducers — removes consumers/retries for invisible producers
 *
 * Does not own the sync loop, reconciliation timer, WS signals, or media key store.
 */
import type { SfuRoomProducer } from "@seclettr/protocol";
import { type types as MediasoupTypes } from "mediasoup-client";
import {
  bindReceiverFrameDecryption,
  type GroupCallFrameCryptoHandle,
} from "@/calls/shared/crypto/frame-crypto";
import {
  logGroupCallError,
  logGroupCallInfo,
  logGroupCallWarn,
} from "@/calls/group/runtime/media-key/logger";
import {
  computeConsumeRetryDelayMs,
  getProducerRemovalGracePeriodMs,
} from "./remote-producers";
import type { SfuHttpClient } from "./http-client";
import {
  emitRemoteMediaUpdate,
  upsertRemoteEntry,
  type GroupCallRemoteMedia,
  type RemoteParticipantMediaInternal,
} from "./runtime-common";
import type { mergeRemoteFrameKeyContexts } from "./runtime-common";
import type {
  GroupCallMediaEncryptionMode,
  ManagedConsumer,
  RecvTransport,
} from "./types";

export interface ConsumerManagerOptions {
  roomId: string;
  userId: string;
  deviceId: string;
  recvTransport: RecvTransport;
  rtpCapabilities: MediasoupTypes.RtpCapabilities;
  mediaEncryptionMode: GroupCallMediaEncryptionMode;
  sfuHttpClient: Pick<SfuHttpClient, "consume" | "resumeConsumer">;
  onRemoteMediaUpdate?: (participants: GroupCallRemoteMedia[]) => void;
}

type ConsumeRetryState = { retryAt: number; attempts: number };

export function createConsumerManager(options: ConsumerManagerOptions) {
  const frameCryptoEnabled = options.mediaEncryptionMode !== "off";
  const frameCryptoRequired = options.mediaEncryptionMode === "required";

  const remoteMediaByUserId = new Map<string, RemoteParticipantMediaInternal>();
  const consumersByProducerId = new Map<string, ManagedConsumer>();
  const remoteFrameCryptoByProducerId = new Map<string, GroupCallFrameCryptoHandle>();
  const remoteFrameKeyContextsByDeviceId = new Map<string, ReturnType<typeof mergeRemoteFrameKeyContexts>>();
  const consumeRetryByProducerId = new Map<string, ConsumeRetryState>();
  const removedProducerGraceById = new Map<string, number>();
  let closed = false;

  const markProducerInGracePeriod = (producerId: string) => {
    const gracePeriod = getProducerRemovalGracePeriodMs();
    removedProducerGraceById.set(producerId, Date.now() + gracePeriod);
  };

  const isProducerInGracePeriod = (producerId: string, now: number): boolean => {
    const graceUntil = removedProducerGraceById.get(producerId);
    if (!graceUntil) return false;
    if (graceUntil <= now) {
      removedProducerGraceById.delete(producerId);
      return false;
    }
    return true;
  };

  const closePartialConsumer = (consumer: MediasoupTypes.Consumer | null) => {
    if (!consumer) return;
    consumer.close();
  };

  const closeReceiverFrameCrypto = (receiverFrameCrypto: GroupCallFrameCryptoHandle | null) => {
    if (!receiverFrameCrypto) return;
    receiverFrameCrypto.close();
  };

  const removeManagedConsumer = (producerId: string) => {
    const managed = consumersByProducerId.get(producerId);
    if (!managed) return;

    consumersByProducerId.delete(producerId);

    if (remoteFrameCryptoByProducerId.has(producerId)) {
      logGroupCallInfo("[group-call] receiver frame transform detached", {
        roomId: options.roomId,
        producerId,
        userId: managed.userId,
        deviceId: managed.deviceId,
        kind: managed.kind,
        source: managed.source,
      });
    }

    remoteFrameCryptoByProducerId.get(producerId)?.close();
    remoteFrameCryptoByProducerId.delete(producerId);

    const participant = remoteMediaByUserId.get(managed.userId);
    if (participant) {
      if (managed.kind === "audio") {
        participant.audioStreamsByProducerId.delete(producerId);
      }
      if (managed.kind === "video") {
        participant.videoSlotsByProducerId.delete(producerId);
      }
      if (
        participant.audioStreamsByProducerId.size === 0 &&
        participant.videoSlotsByProducerId.size === 0
      ) {
        remoteMediaByUserId.delete(managed.userId);
      }
    }

    managed.consumer.track.removeEventListener("ended", managed.onTrackEnded);
    managed.consumer.close();
    emitRemoteMediaUpdate(remoteMediaByUserId, options.onRemoteMediaUpdate);
  };

  const consumeRemoteProducer = async (producer: SfuRoomProducer): Promise<void> => {
    if (closed || consumersByProducerId.has(producer.producerId)) return;

    let receiverFrameCrypto: GroupCallFrameCryptoHandle | null = null;
    let consumer: MediasoupTypes.Consumer | null = null;
    try {
      const consumed = await options.sfuHttpClient.consume(
        options.roomId,
        options.userId,
        options.recvTransport.id,
        producer.producerId,
        options.rtpCapabilities
      );

      consumer = await options.recvTransport.consume({
        id: consumed.consumerId,
        producerId: consumed.producerId,
        kind: consumed.kind,
        rtpParameters: consumed.rtpParameters as MediasoupTypes.RtpParameters,
        onRtpReceiver: producer.deviceId
          ? (rtpReceiver) => {
              if (!frameCryptoEnabled) return;
              receiverFrameCrypto = bindReceiverFrameDecryption(
                rtpReceiver,
                {
                  roomId: options.roomId,
                  deviceId: producer.deviceId!,
                  kind: consumed.kind,
                  source: producer.source ?? null,
                },
                remoteFrameKeyContextsByDeviceId.get(producer.deviceId!) ?? [],
                () => {
                  logGroupCallWarn("[sfu] receiver frame-crypto pipeline failed", {
                    roomId: options.roomId,
                    producerId: producer.producerId,
                    userId: producer.userId,
                    deviceId: producer.deviceId,
                    kind: consumed.kind,
                  });
                },
                // Required mode is fail-closed: drop cleartext frames instead
                // of accepting a downgrade (see AUDIT.md C4).
                frameCryptoRequired
              );
              if (frameCryptoRequired && !receiverFrameCrypto.supported) {
                throw new Error("Group call frame encryption is required but unsupported by this browser");
              }
              logGroupCallInfo("[group-call] receiver frame transform attached", {
                roomId: options.roomId,
                producerId: producer.producerId,
                userId: producer.userId,
                deviceId: producer.deviceId,
                kind: consumed.kind,
                source: producer.source ?? null,
                supported: receiverFrameCrypto.supported,
              });
            }
          : undefined,
      });

      if (frameCryptoRequired && !producer.deviceId) {
        throw new Error("Group call frame encryption requires device-scoped producer metadata");
      }

      await options.sfuHttpClient.resumeConsumer(consumed.consumerId, {
        roomId: options.roomId,
        userId: options.userId,
      });

      const onTrackEnded = () => {
        removeManagedConsumer(producer.producerId);
      };

      const managed: ManagedConsumer = {
        producerId: producer.producerId,
        consumer,
        userId: producer.userId,
        deviceId: producer.deviceId ?? null,
        kind: consumed.kind,
        source: producer.source ?? null,
        onTrackEnded,
      };

      consumersByProducerId.set(producer.producerId, managed);
      if (receiverFrameCrypto) {
        remoteFrameCryptoByProducerId.set(producer.producerId, receiverFrameCrypto);
      }

      consumer.on("transportclose", () => {
        removeManagedConsumer(producer.producerId);
      });
      consumer.track.addEventListener("ended", onTrackEnded);

      const remoteEntry = upsertRemoteEntry(remoteMediaByUserId, producer.userId);
      const mediaStream = new MediaStream([consumer.track]);
      if (consumed.kind === "audio") {
        remoteEntry.audioStreamsByProducerId.set(producer.producerId, mediaStream);
      } else {
        remoteEntry.videoSlotsByProducerId.set(producer.producerId, {
          producerId: producer.producerId,
          stream: mediaStream,
          source: producer.source ?? null,
          deviceId: producer.deviceId ?? null,
        });
      }

      emitRemoteMediaUpdate(remoteMediaByUserId, options.onRemoteMediaUpdate);
    } catch (error) {
      closeReceiverFrameCrypto(receiverFrameCrypto);
      closePartialConsumer(consumer);
      throw error;
    }
  };

  const pruneInvisibleProducers = (visibleProducerIds: Set<string>) => {
    for (const producerId of consumeRetryByProducerId.keys()) {
      if (!visibleProducerIds.has(producerId)) {
        consumeRetryByProducerId.delete(producerId);
      }
    }

    for (const producerId of consumersByProducerId.keys()) {
      if (!visibleProducerIds.has(producerId)) {
        removeManagedConsumer(producerId);
      }
    }
  };

  const pruneExpiredProducerGracePeriods = (now: number) => {
    for (const [producerId, graceUntil] of removedProducerGraceById.entries()) {
      if (graceUntil <= now) {
        removedProducerGraceById.delete(producerId);
      }
    }
  };

  const shouldSkipRemoteProducer = (
    producer: SfuRoomProducer,
    retryState: ConsumeRetryState | undefined,
    now: number
  ): boolean => {
    if (consumersByProducerId.has(producer.producerId)) return true;
    if ((retryState?.retryAt ?? 0) > now) return true;
    return isProducerInGracePeriod(producer.producerId, now);
  };

  const handleConsumeRemoteProducerFailure = (
    producer: SfuRoomProducer,
    retryState: ConsumeRetryState | undefined,
    error: unknown
  ): void => {
    const previousAttempts = retryState?.attempts ?? 0;
    const nextAttempts = previousAttempts + 1;
    const retryDelayMs = computeConsumeRetryDelayMs(nextAttempts);
    consumeRetryByProducerId.set(producer.producerId, {
      retryAt: Date.now() + retryDelayMs,
      attempts: nextAttempts,
    });
    logGroupCallError("[group-call] skipping remote producer after consume failure", {
      producerId: producer.producerId,
      userId: producer.userId,
      deviceId: producer.deviceId ?? null,
      source: producer.source ?? null,
      attempts: nextAttempts,
      retryDelayMs,
      error,
    });
  };

  return {
    remoteMediaByUserId,
    consumersByProducerId,
    remoteFrameCryptoByProducerId,
    remoteFrameKeyContextsByDeviceId,
    consumeRetryByProducerId,
    removedProducerGraceById,
    consumeRemoteProducer,
    removeManagedConsumer,
    pruneInvisibleProducers,
    pruneExpiredProducerGracePeriods,
    shouldSkipRemoteProducer,
    handleConsumeRemoteProducerFailure,
    markProducerInGracePeriod,
    close: () => {
      closed = true;
      for (const producerId of consumersByProducerId.keys()) {
        removeManagedConsumer(producerId);
      }
    },
  };
}
