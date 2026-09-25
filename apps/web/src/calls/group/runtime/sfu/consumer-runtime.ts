/**
 * consumer-runtime — SFU consumer lifecycle manager for group calls.
 *
 * Owns:
 *   - createSfuConsumerRuntime — factory that returns GroupSfuConsumerRuntime
 *   - GroupSfuConsumerRuntime interface (syncRemoteProducers, removeParticipantMedia,
 *     setRemoteMediaKey, getDebugSnapshot, close)
 *   - Consumer creation, retry state, and grace-period logic for remote producers
 *     (delegated to ConsumerManager)
 *   - Media key store (delegated to FrameKeyStore)
 *   - WebSocket signal subscription for producer_state events
 *   - 30-second reconciliation timer as a safety net for missed signals
 *
 * Does not own producer-side publishing (see producer-runtime.ts), RTP parameter
 * negotiation (see rtp-parameters.ts), or the SFU HTTP client (see http-client.ts).
 */
import type {
  SfuRoomProducer,
  WsServerMessage,
} from "@seclettr/protocol";
import { type types as MediasoupTypes } from "mediasoup-client";
import type { ReceivedGroupCallMediaKey } from "@/calls/group/runtime/media-key/media-key";
import {
  logGroupCallError,
} from "@/calls/group/runtime/media-key/logger";
import {
  filterRemoteProducersForConsume,
  dedupeRemoteProducersBySlot,
} from "./remote-producers";
import type { SfuHttpClient } from "./http-client";
import {
  emitRemoteMediaUpdate,
  snapshotMediaTrack,
  type GroupCallRemoteMedia,
} from "./runtime-common";
import type {
  GroupCallMediaEncryptionMode,
  RecvTransport,
} from "./types";
import { createConsumerManager } from "./consumer-manager";
import { createFrameKeyStore } from "./frame-key-store";

interface CreateSfuConsumerRuntimeOptions {
  roomId: string;
  userId: string;
  deviceId: string;
  recvTransport: RecvTransport;
  rtpCapabilities: MediasoupTypes.RtpCapabilities;
  mediaEncryptionMode: GroupCallMediaEncryptionMode;
  getLocalProducerIds: () => Set<string>;
  onRemoteMediaUpdate?: (participants: GroupCallRemoteMedia[]) => void;
  sfuHttpClient: Pick<SfuHttpClient, "consume" | "resumeConsumer" | "listRoomProducers">;
  wsClient: {
    on: (listener: (message: WsServerMessage) => void) => () => void;
  };
}

export interface GroupSfuConsumerRuntime {
  syncRemoteProducers: () => Promise<void>;
  removeParticipantMedia: (userId: string) => void;
  setRemoteMediaKey: (senderDeviceId: string, mediaKey: ReceivedGroupCallMediaKey | null) => void;
  getDebugSnapshot: () => Record<string, unknown>;
  close: () => void;
}

export function createSfuConsumerRuntime(
  options: CreateSfuConsumerRuntimeOptions
): GroupSfuConsumerRuntime {
  const frameCryptoEnabled = options.mediaEncryptionMode !== "off";

  const consumerManager = createConsumerManager({
    roomId: options.roomId,
    userId: options.userId,
    deviceId: options.deviceId,
    recvTransport: options.recvTransport,
    rtpCapabilities: options.rtpCapabilities,
    mediaEncryptionMode: options.mediaEncryptionMode,
    sfuHttpClient: options.sfuHttpClient,
    onRemoteMediaUpdate: options.onRemoteMediaUpdate,
  });

  const frameKeyStore = createFrameKeyStore({
    roomId: options.roomId,
    frameCryptoEnabled,
  });

  let cachedProducerList: SfuRoomProducer[] = [];
  let cachedProducerListVersion = 0;

  let closed = false;
  let syncInFlight = false;
  let syncQueued = false;
  let reconciliationTimer: number | null = null;
  let lastSyncCompletedAt = 0;
  const hasDocument = typeof document !== "undefined";

  // ============================================
  // Timer management
  // ============================================

  const clearReconciliationTimer = () => {
    if (reconciliationTimer !== null) {
      clearTimeout(reconciliationTimer);
      reconciliationTimer = null;
    }
  };

  const scheduleReconciliation = () => {
    if (closed) return;
    clearReconciliationTimer();
    reconciliationTimer = globalThis.window.setTimeout(() => {
      reconciliationTimer = null;
      queueRemoteSync().catch((error) => {
        logGroupCallError("[group-call] failed to sync remote producers", error);
      });
    }, 30_000);
  };

  // ============================================
  // Sync request logic
  // ============================================

  const requestRemoteSync = () => {
    if (closed) return;
    if (syncInFlight) {
      syncQueued = true;
      return;
    }
    queueRemoteSync().catch((error) => {
      logGroupCallError("[group-call] failed to sync remote producers", error);
    });
  };

  // ============================================
  // Core sync logic
  // ============================================

  const doSyncRemoteProducers = async (): Promise<void> => {
    if (closed) return;

    const producers = await options.sfuHttpClient.listRoomProducers(options.roomId);
    cachedProducerList = producers;
    cachedProducerListVersion++;

    const remoteProducers = filterRemoteProducersForConsume(producers, {
      userId: options.userId,
      deviceId: options.deviceId,
      localProducerIds: options.getLocalProducerIds(),
    });
    const nextRemoteProducers = dedupeRemoteProducersBySlot(remoteProducers);
    const visibleProducerIds = new Set(nextRemoteProducers.map((p) => p.producerId));
    const now = Date.now();

    consumerManager.pruneInvisibleProducers(visibleProducerIds);
    consumerManager.pruneExpiredProducerGracePeriods(now);

    for (const producer of nextRemoteProducers) {
      const retryState = consumerManager.consumeRetryByProducerId.get(producer.producerId);
      if (consumerManager.shouldSkipRemoteProducer(producer, retryState, now)) {
        continue;
      }

      try {
        await consumerManager.consumeRemoteProducer(producer);
        consumerManager.consumeRetryByProducerId.delete(producer.producerId);
      } catch (error) {
        consumerManager.handleConsumeRemoteProducerFailure(producer, retryState, error);
      }
    }

    lastSyncCompletedAt = Date.now();
    emitRemoteMediaUpdate(consumerManager.remoteMediaByUserId, options.onRemoteMediaUpdate);
  };

  const queueRemoteSync = async (): Promise<void> => {
    if (closed) return;
    if (syncInFlight) {
      syncQueued = true;
      return;
    }

    syncInFlight = true;
    try {
      do {
        syncQueued = false;
        await doSyncRemoteProducers();
      } while (syncQueued && !closed);
    } finally {
      syncInFlight = false;
      scheduleReconciliation();
    }
  };

  // ============================================
  // WebSocket signal handling
  // ============================================

  const unsubscribeProducerSignals = options.wsClient.on((message) => {
    if (message.type !== "group.call.producer_state") return;
    if (message.callId !== options.roomId) return;
    if (message.deviceId === options.deviceId) return;

    if (message.state === "removed") {
      consumerManager.consumeRetryByProducerId.delete(message.producerId);
      consumerManager.markProducerInGracePeriod(message.producerId);

      const managed = consumerManager.consumersByProducerId.get(message.producerId);
      if (managed?.userId === message.userId && managed?.deviceId === message.deviceId) {
        consumerManager.removeManagedConsumer(message.producerId);
      }
      return;
    }

    consumerManager.removedProducerGraceById.delete(message.producerId);
    requestRemoteSync();
  });

  // ============================================
  // Media key handling
  // ============================================

  const handleVisibilityChange = () => {
    if (closed || typeof document === "undefined") return;
    if (!document.hidden) {
      requestRemoteSync();
    }
  };

  if (hasDocument) {
    document.addEventListener("visibilitychange", handleVisibilityChange);
  }

  // ============================================
  // Public API
  // ============================================

  return {
    syncRemoteProducers: async () => {
      await queueRemoteSync();
    },
    removeParticipantMedia: (userId: string) => {
      const producerIds = [...consumerManager.consumersByProducerId.entries()]
        .filter(([, managed]) => managed.userId === userId)
        .map(([producerId]) => producerId);

      for (const producerId of producerIds) {
        consumerManager.markProducerInGracePeriod(producerId);
        consumerManager.consumeRetryByProducerId.delete(producerId);
        consumerManager.removeManagedConsumer(producerId);
      }

      if (consumerManager.remoteMediaByUserId.has(userId)) {
        consumerManager.remoteMediaByUserId.delete(userId);
        emitRemoteMediaUpdate(consumerManager.remoteMediaByUserId, options.onRemoteMediaUpdate);
      }
    },
    setRemoteMediaKey: (senderDeviceId, mediaKey) => {
      frameKeyStore.setRemoteMediaKey(
        senderDeviceId,
        mediaKey,
        consumerManager.consumersByProducerId,
        consumerManager.remoteFrameCryptoByProducerId,
      );
    },
    getDebugSnapshot: () => ({
      roomId: options.roomId,
      cachedProducerListVersion,
      cachedProducerCount: cachedProducerList.length,
      consumers: [...consumerManager.consumersByProducerId.values()].map((managed) => ({
        producerId: managed.producerId,
        consumerId: managed.consumer.id,
        userId: managed.userId,
        deviceId: managed.deviceId,
        kind: managed.kind,
        source: managed.source,
        paused: managed.consumer.paused,
        producerPaused: "producerPaused" in managed.consumer
          ? (managed.consumer as MediasoupTypes.Consumer & { producerPaused?: boolean }).producerPaused ?? null
          : null,
        closed: managed.consumer.closed,
        track: snapshotMediaTrack(managed.consumer.track),
      })),
      retryStates: [...consumerManager.consumeRetryByProducerId.entries()].map(([producerId, retryState]) => ({
        producerId,
        retryAt: retryState.retryAt,
        attempts: retryState.attempts,
      })),
      gracePeriodStates: [...consumerManager.removedProducerGraceById.entries()].map(([producerId, graceUntil]) => ({
        producerId,
        graceUntil,
      })),
      remoteFrameCryptoByProducerId: [...consumerManager.remoteFrameCryptoByProducerId.entries()].map(([producerId, handle]) => ({
        producerId,
        supported: handle.supported,
      })),
      participants: [...consumerManager.remoteMediaByUserId.values()].map((participant) => ({
        userId: participant.userId,
        audioStreams: [...participant.audioStreamsByProducerId.keys()],
        videoSlots: [...participant.videoSlotsByProducerId.values()].map((slot) => ({
          producerId: slot.producerId,
          source: slot.source,
        })),
      })),
      lastSyncCompletedAt,
      syncInFlight,
    }),
    close: () => {
      if (closed) return;
      closed = true;
      clearReconciliationTimer();
      unsubscribeProducerSignals();
      if (hasDocument) {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
      consumerManager.close();
      frameKeyStore.zeroize();
    },
  };
}
