/**
 * frame-crypto — WebRTC encoded-frame E2EE pipeline for group calls.
 *
 * Owns:
 *   - GroupCallFrameCryptoHandle interface (supported, failed, setKeyBytes, setKeyContexts, close)
 *   - encryptGroupCallFrame / decryptGroupCallFrame — low-level AES-256-GCM frame wrappers
 *   - decryptGroupCallFrameWithKeyContexts — tries multiple key contexts in order; used
 *     for graceful key rotation where the sender advanced the key before the receiver
 *   - bindSenderFrameEncryption / bindReceiverFrameDecryption — public API that attaches a
 *     frame-crypto transform to an RTCRtpSender or RTCRtpReceiver
 *   - Two transport strategies (chosen automatically by capability detection):
 *       1. RTCRtpScriptTransform (Chrome 94+, Safari 15.4+) — runs in a dedicated Worker
 *       2. createEncodedStreams (legacy Chrome) — runs inline via TransformStream
 *   - iOS WebKit silent-discard detection for RTCRtpScriptTransform
 *   - createNoopHandle — fallback for unsupported browsers (supported = false)
 *
 * Does not own crypto primitives (see frame-crypto-core.ts), capability detection
 * (see frame-crypto-capabilities.ts), or the Worker entry point (see frame-crypto.worker.ts).
 */
import {
  buildAssociatedData,
  cloneKeyInputContexts,
  clearMutableKeyStates,
  decryptGroupCallFramePayload,
  encryptGroupCallFramePayload,
  normalizeKeyInput,
  processFrameBuffer,
  startsWithMagic,
  type EncodedFrame,
  type FrameCryptoDirection,
  type FrameCryptoWorkerEventMessage,
  type FrameCryptoWorkerConfigMessage,
  type GroupCallFrameCryptoContext,
  type GroupCallFrameKeyContext,
  type GroupCallFrameKeyInput,
} from "./frame-crypto-core";
import { logCallMediaError, logCallMediaWarn } from "@/calls/shared/media/call-media-debug";

export type { GroupCallFrameKeyContext, GroupCallFrameKeyInput } from "./frame-crypto-core";

export interface GroupCallFrameCryptoHandle {
  readonly supported: boolean;
  /** True after the encoded-streams pipeline dies unexpectedly. Always false for unsupported (noop) handles. */
  readonly failed: boolean;
  setKeyBytes: (keyBytes: Uint8Array | null) => void;
  setKeyContexts: (keyContexts: readonly GroupCallFrameKeyContext[]) => void;
  close: () => void;
}

type EncodedStreams = {
  readable: ReadableStream<EncodedFrame>;
  writable: WritableStream<EncodedFrame>;
};

type EncodedStreamsCapable = {
  createEncodedStreams?: () => EncodedStreams;
};

type ScriptTransformCapable = {
  transform?: unknown;
};

type ScriptTransformConstructor = new (worker: Worker, options?: unknown) => unknown;

interface ScriptTransformWindow extends Window {
  RTCRtpScriptTransform?: ScriptTransformConstructor;
}

export async function encryptGroupCallFrame(
  plaintext: Uint8Array,
  keyBytes: Uint8Array,
  additionalData: Uint8Array
): Promise<Uint8Array> {
  return encryptGroupCallFramePayload(plaintext, keyBytes, additionalData);
}

export async function decryptGroupCallFrame(
  encodedFrame: Uint8Array,
  keyBytes: Uint8Array,
  additionalData: Uint8Array
): Promise<Uint8Array> {
  return decryptGroupCallFramePayload(encodedFrame, keyBytes, additionalData);
}

export async function decryptGroupCallFrameWithKeyContexts(
  encodedFrame: Uint8Array,
  keyContexts: readonly GroupCallFrameKeyContext[],
  additionalData: Uint8Array
): Promise<Uint8Array> {
  if (!startsWithMagic(encodedFrame)) {
    return Uint8Array.from(encodedFrame);
  }

  let lastError: unknown = null;
  for (const keyContext of keyContexts) {
    try {
      return await decryptGroupCallFrame(encodedFrame, keyContext.keyBytes, additionalData);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to decrypt group-call frame with available keys");
}

function createNoopHandle(): GroupCallFrameCryptoHandle {
  return {
    supported: false,
    failed: false,
    setKeyBytes: () => undefined,
    setKeyContexts: () => undefined,
    close: () => undefined,
  };
}

function resolveScriptTransformConstructor(): ScriptTransformConstructor | null {
  if (globalThis.window === undefined) return null;
  return (globalThis as unknown as ScriptTransformWindow).RTCRtpScriptTransform ?? null;
}

function isScriptTransformCapable(endpoint: EncodedStreamsCapable | ScriptTransformCapable): endpoint is ScriptTransformCapable {
  return "transform" in endpoint;
}

function isEncodedStreamsCapable(endpoint: EncodedStreamsCapable | ScriptTransformCapable): endpoint is EncodedStreamsCapable {
  return "createEncodedStreams" in endpoint;
}

function serializeKeyInputForWorker(input: GroupCallFrameKeyInput): readonly GroupCallFrameKeyContext[] {
  return cloneKeyInputContexts(input);
}

function postWorkerConfiguration(
  worker: Worker,
  message: Omit<FrameCryptoWorkerConfigMessage, "type">
): void {
  const payload: FrameCryptoWorkerConfigMessage = {
    type: "configure",
    ...message,
  };
  worker.postMessage(payload);
}

function bindFrameCryptoScriptTransform(
  endpoint: ScriptTransformCapable,
  direction: FrameCryptoDirection,
  context: GroupCallFrameCryptoContext,
  initialKeyInput: GroupCallFrameKeyInput,
  onPipelineFailed?: () => void,
  requireEncryption = false
): GroupCallFrameCryptoHandle {
  const ScriptTransform = resolveScriptTransformConstructor();
  if (!ScriptTransform || typeof Worker === "undefined") {
    logCallMediaWarn("[frame-crypto] RTCRtpScriptTransform or Worker not available — frame encryption disabled", { direction, context });
    return createNoopHandle();
  }

  let worker: Worker;
  try {
    worker = new Worker(new URL("./frame-crypto.worker.ts", import.meta.url), { type: "module" });
  } catch (err) {
    logCallMediaError("[frame-crypto] failed to create frame-crypto worker — frame encryption disabled", { direction, context, err });
    return createNoopHandle();
  }

  const handleId = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
  let closed = false;
  let pipelineFailed = false;

  const detachTransform = () => {
    try {
      endpoint.transform = undefined;
    } catch {
      // Best-effort only; some browsers expose transform as readonly during teardown.
    }
  };

  const markPipelineFailed = () => {
    if (closed || pipelineFailed) {
      return;
    }
    pipelineFailed = true;
    detachTransform();
    worker.terminate();
    onPipelineFailed?.();
  };

  const handleWorkerMessage = (event: MessageEvent<FrameCryptoWorkerEventMessage>) => {
    if (event.data?.type !== "pipeline-failed" || event.data.handleId !== handleId) {
      return;
    }
    markPipelineFailed();
  };

  const handleWorkerError = () => {
    markPipelineFailed();
  };

  worker.addEventListener("message", handleWorkerMessage as EventListener);
  worker.addEventListener("messageerror", handleWorkerError as EventListener);
  worker.addEventListener("error", handleWorkerError as EventListener);

  const configure = (nextKeyInput: GroupCallFrameKeyInput) => {
    const keyContexts = serializeKeyInputForWorker(nextKeyInput);
    postWorkerConfiguration(worker, {
      handleId,
      direction,
      context,
      keyContexts,
      requireEncryption,
    });
  };

  const cleanup = () => {
    worker.removeEventListener("message", handleWorkerMessage as EventListener);
    worker.removeEventListener("messageerror", handleWorkerError as EventListener);
    worker.removeEventListener("error", handleWorkerError as EventListener);
    worker.terminate();
  };

  try {
    configure(initialKeyInput);
    endpoint.transform = new ScriptTransform(worker, {
      handleId,
      direction,
      context,
    });
  } catch (err) {
    logCallMediaError("[frame-crypto] failed to attach RTCRtpScriptTransform — frame encryption disabled", { direction, context, err });
    cleanup();
    return createNoopHandle();
  }

  // On some iOS WebKit builds the transform setter accepts the value without
  // throwing but silently discards it (onrtctransform never fires). Detect
  // this by reading back the property immediately after assignment.
  if (!endpoint.transform) {
    logCallMediaWarn("[frame-crypto] RTCRtpScriptTransform assignment silently ignored — frame encryption disabled", { direction, context });
    cleanup();
    return createNoopHandle();
  }

  return {
    supported: true,
    get failed() { return pipelineFailed; },
    setKeyBytes: (nextKeyBytes) => {
      if (closed || pipelineFailed) return;
      configure(nextKeyBytes);
    },
    setKeyContexts: (nextKeyContexts) => {
      if (closed || pipelineFailed) return;
      configure(nextKeyContexts);
    },
    close: () => {
      if (closed) return;
      closed = true;
      detachTransform();
      worker.removeEventListener("message", handleWorkerMessage as EventListener);
      worker.removeEventListener("messageerror", handleWorkerError as EventListener);
      worker.removeEventListener("error", handleWorkerError as EventListener);
      worker.postMessage({
        type: "close",
        handleId,
      });
      worker.terminate();
    },
  };
}

function bindFrameCryptoTransform(
  endpoint: EncodedStreamsCapable | ScriptTransformCapable,
  direction: FrameCryptoDirection,
  context: GroupCallFrameCryptoContext,
  initialKeyInput: GroupCallFrameKeyInput,
  onPipelineFailed?: () => void,
  requireEncryption = false
): GroupCallFrameCryptoHandle {
  let encodedStreams: EncodedStreams | undefined;
  let legacyEncodedStreamsFailed = false;
  try {
    encodedStreams = isEncodedStreamsCapable(endpoint)
      ? endpoint.createEncodedStreams?.()
      : undefined;
  } catch {
    legacyEncodedStreamsFailed = true;
  }
  if (!encodedStreams) {
    if (isScriptTransformCapable(endpoint)) {
      return bindFrameCryptoScriptTransform(
        endpoint,
        direction,
        context,
        initialKeyInput,
        onPipelineFailed,
        requireEncryption
      );
    }
    if (legacyEncodedStreamsFailed) {
      logCallMediaWarn("[frame-crypto] createEncodedStreams() threw — frame encryption disabled", { direction, context });
    } else {
      logCallMediaWarn("[frame-crypto] createEncodedStreams() unavailable — frame encryption disabled", { direction, context });
    }
    return createNoopHandle();
  }

  let keyStates = normalizeKeyInput(initialKeyInput);
  const additionalData = buildAssociatedData({
    ...context,
  });
  let closed = false;
  let pipelineFailed = false;
  // Warn once per handle when recv frames are dropped due to an empty key ring
  // (consumer created before the media key has arrived from the sender).
  let hasWarnedEmptyKeyDrop = false;

  const transform = new TransformStream<EncodedFrame, EncodedFrame>({
    async transform(frame, controller) {
      if (closed) {
        // Keep transport pipeline alive after runtime close (e.g. frame->transport fallback).
        controller.enqueue(frame);
        return;
      }

      const nextData = await processFrameBuffer(frame.data, {
        direction,
        additionalData,
        keyStates,
        requireEncryption,
      });
      if (nextData === null) {
        if (direction === "recv" && keyStates.length === 0 && !hasWarnedEmptyKeyDrop) {
          hasWarnedEmptyKeyDrop = true;
          logCallMediaWarn("[frame-crypto] dropping encrypted recv frame — key ring empty (media key not yet received)", { context });
        }
        return;
      }

      hasWarnedEmptyKeyDrop = false;
      frame.data = nextData;
      controller.enqueue(frame);
    },
  });

  encodedStreams.readable
    .pipeThrough(transform)
    .pipeTo(encodedStreams.writable)
    .catch((err) => {
      logCallMediaError("[frame-crypto] encoded-streams pipeline error", { direction, context, err });
      // Self-cleanup: clear key material when the pipeline dies unexpectedly.
      // Without this, keys would stay in memory until the external caller
      // invokes close() via normal teardown.
      if (!closed) {
        closed = true;
        pipelineFailed = true;
        clearMutableKeyStates(keyStates);
        keyStates = [];
        onPipelineFailed?.();
      }
    });

  return {
    supported: true,
    get failed() { return pipelineFailed; },
    setKeyBytes: (nextKeyBytes) => {
      clearMutableKeyStates(keyStates);
      keyStates = normalizeKeyInput(nextKeyBytes);
    },
    setKeyContexts: (nextKeyContexts) => {
      clearMutableKeyStates(keyStates);
      keyStates = normalizeKeyInput(nextKeyContexts);
    },
    close: () => {
      closed = true;
      clearMutableKeyStates(keyStates);
      keyStates = [];
    },
  };
}

export function bindSenderFrameEncryption(
  sender: RTCRtpSender,
  context: GroupCallFrameCryptoContext,
  initialKeyInput: GroupCallFrameKeyInput,
  onPipelineFailed?: () => void,
  requireEncryption = false
): GroupCallFrameCryptoHandle {
  return bindFrameCryptoTransform(sender as EncodedStreamsCapable, "send", context, initialKeyInput, onPipelineFailed, requireEncryption);
}

export function bindReceiverFrameDecryption(
  receiver: RTCRtpReceiver,
  context: GroupCallFrameCryptoContext,
  initialKeyInput: GroupCallFrameKeyInput,
  onPipelineFailed?: () => void,
  requireEncryption = false
): GroupCallFrameCryptoHandle {
  return bindFrameCryptoTransform(receiver as EncodedStreamsCapable, "recv", context, initialKeyInput, onPipelineFailed, requireEncryption);
}
