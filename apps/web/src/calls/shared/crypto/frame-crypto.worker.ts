/**
 * frame-crypto.worker — RTCRtpScriptTransform Worker entry point for frame E2EE.
 *
 * Owns:
 *   - onrtctransform event handler: receives the RTCRtpScriptTransformer and starts
 *     piping encoded frames through processFrameBuffer (encrypt or decrypt)
 *   - message handler: processes configure and close messages from the main thread
 *   - Per-handle state management (TransformRuntimeState) keyed by handleId
 *   - Key material updates via configure messages (normalizeKeyInput + clearMutableKeyStates)
 *   - pipeline-failed notification to the main thread on unrecoverable pipeline errors
 *
 * Runs entirely in a dedicated Worker context. Does not import anything from the
 * main thread or hold references to DOM objects.
 * Crypto primitives are provided by frame-crypto-core.ts (shared module).
 */
import {
  buildAssociatedData,
  clearMutableKeyStates,
  normalizeKeyInput,
  processFrameBuffer,
  type EncodedFrame,
  type FrameCryptoDirection,
  type FrameCryptoWorkerEventMessage,
  type FrameCryptoWorkerConfigMessage,
  type FrameCryptoWorkerMessage,
  type GroupCallFrameCryptoContext,
  type MutableKeyState,
} from "./frame-crypto-core";

interface ScriptTransformer {
  readable: ReadableStream<EncodedFrame>;
  writable: WritableStream<EncodedFrame>;
  options?: {
    handleId: string;
    direction: FrameCryptoDirection;
    context: GroupCallFrameCryptoContext;
  };
}

interface ScriptTransformEvent extends Event {
  transformer: ScriptTransformer;
}

interface TransformRuntimeState {
  direction: FrameCryptoDirection;
  additionalData: Uint8Array;
  keyStates: MutableKeyState[];
  requireEncryption: boolean;
  closed: boolean;
  pipelineStarted: boolean;
}

type WorkerScope = typeof globalThis & {
  onrtctransform?: ((event: ScriptTransformEvent) => void) | null;
};

const globalScope = globalThis as WorkerScope;
const runtimeByHandleId = new Map<string, TransformRuntimeState>();

function ensureRuntime(options: {
  handleId: string;
  direction: FrameCryptoDirection;
  context: GroupCallFrameCryptoContext;
}): TransformRuntimeState {
  const existing = runtimeByHandleId.get(options.handleId);
  if (existing) {
    existing.direction = options.direction;
    existing.additionalData = buildAssociatedData(options.context);
    return existing;
  }

  const runtime: TransformRuntimeState = {
    direction: options.direction,
    additionalData: buildAssociatedData(options.context),
    keyStates: [],
    requireEncryption: false,
    closed: false,
    pipelineStarted: false,
  };
  runtimeByHandleId.set(options.handleId, runtime);
  return runtime;
}

function updateRuntime(message: FrameCryptoWorkerConfigMessage): void {
  const runtime = ensureRuntime(message);
  clearMutableKeyStates(runtime.keyStates);
  runtime.keyStates = normalizeKeyInput(message.keyContexts);
  runtime.requireEncryption = message.requireEncryption === true;
}

function closeRuntime(handleId: string): void {
  const runtime = runtimeByHandleId.get(handleId);
  if (!runtime) {
    return;
  }
  runtime.closed = true;
  clearMutableKeyStates(runtime.keyStates);
  runtime.keyStates = [];
  runtimeByHandleId.delete(handleId);
}

function createFrameTransform(runtime: TransformRuntimeState): TransformStream<EncodedFrame, EncodedFrame> {
  return new TransformStream<EncodedFrame, EncodedFrame>({
    async transform(frame, controller) {
      if (runtime.closed) {
        controller.enqueue(frame);
        return;
      }

      const nextData = await processFrameBuffer(frame.data, runtime);
      if (nextData === null) {
        return;
      }

      frame.data = nextData;
      controller.enqueue(frame);
    },
  });
}

globalScope.onmessage = (event: MessageEvent<FrameCryptoWorkerMessage>) => {
  const message = event.data;
  if (!message) {
    return;
  }
  if (message.type === "configure") {
    updateRuntime(message);
    return;
  }
  if (message.type === "close") {
    closeRuntime(message.handleId);
  }
};

globalScope.onrtctransform = (event: ScriptTransformEvent) => {
  const options = event.transformer.options;
  if (!options) {
    return;
  }
  const runtime = ensureRuntime(options);
  if (runtime.pipelineStarted) {
    return;
  }

  runtime.pipelineStarted = true;
  event.transformer.readable
    .pipeThrough(createFrameTransform(runtime))
    .pipeTo(event.transformer.writable)
    .catch(() => {
      if (!runtime.closed) {
        const message: FrameCryptoWorkerEventMessage = {
          type: "pipeline-failed",
          handleId: options.handleId,
        };
        globalScope.postMessage(message);
      }
      closeRuntime(options.handleId);
    });
};
