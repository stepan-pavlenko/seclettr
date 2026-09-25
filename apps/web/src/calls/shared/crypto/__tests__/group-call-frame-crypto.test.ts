import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import {
  bindSenderFrameEncryption,
  decryptGroupCallFrame,
  decryptGroupCallFrameWithKeyContexts,
  encryptGroupCallFrame,
} from "@/calls/shared/crypto/frame-crypto";
import {
  normalizeKeyInput,
  processFrameBuffer,
} from "@/calls/shared/crypto/frame-crypto-core";

describe("group-call-frame-crypto", () => {
  const originalWindow = globalThis.window;
  const originalWorker = globalThis.Worker;
  const originalScriptTransform = "RTCRtpScriptTransform" in globalThis
    ? (globalThis as typeof globalThis & { RTCRtpScriptTransform?: unknown }).RTCRtpScriptTransform
    : undefined;

  afterEach(() => {
    if (originalWindow) {
      vi.stubGlobal("window", originalWindow);
    } else {
      vi.unstubAllGlobals();
    }

    if (originalWorker) {
      vi.stubGlobal("Worker", originalWorker);
    }

    if (originalScriptTransform === undefined) {
      Reflect.deleteProperty(globalThis, "RTCRtpScriptTransform");
    } else {
      Object.defineProperty(globalThis, "RTCRtpScriptTransform", {
        configurable: true,
        writable: true,
        value: originalScriptTransform,
      });
    }
  });

  it("encrypts and decrypts a frame with matching associated data", async () => {
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const additionalData = new TextEncoder().encode("seclettr.group-call.frame:test");
    const plaintext = new TextEncoder().encode("hello-frame");

    const encrypted = await encryptGroupCallFrame(plaintext, keyBytes, additionalData);
    expect(encrypted).not.toEqual(plaintext);
    expect(Array.from(encrypted.slice(0, 5))).toEqual([
      0x51,
      0x4d,
      0x47,
      0x43,
      0x01,
    ]);

    const decrypted = await decryptGroupCallFrame(encrypted, keyBytes, additionalData);
    expect(new TextDecoder().decode(decrypted)).toBe("hello-frame");
  });

  it("rejects decrypt when associated data does not match", async () => {
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const plaintext = new TextEncoder().encode("hello-frame");
    const encrypted = await encryptGroupCallFrame(
      plaintext,
      keyBytes,
      new TextEncoder().encode("seclettr.group-call.frame:good")
    );

    await expect(
      decryptGroupCallFrame(
        encrypted,
        keyBytes,
        new TextEncoder().encode("seclettr.group-call.frame:bad")
      )
    ).rejects.toThrow();
  });

  it("binds the video source into associated data", async () => {
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const plaintext = new TextEncoder().encode("hello-frame");
    const cameraAdditionalData = new TextEncoder().encode(
      "seclettr.group-call.frame:room-1:device-1:video:camera"
    );
    const screenAdditionalData = new TextEncoder().encode(
      "seclettr.group-call.frame:room-1:device-1:video:screen"
    );

    const encrypted = await encryptGroupCallFrame(
      plaintext,
      keyBytes,
      cameraAdditionalData
    );

    await expect(
      decryptGroupCallFrame(encrypted, keyBytes, screenAdditionalData)
    ).rejects.toThrow();
  });

  it("passes through unwrapped frames for compatibility", async () => {
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const plaintext = new TextEncoder().encode("legacy-frame");

    const decrypted = await decryptGroupCallFrame(
      plaintext,
      keyBytes,
      new TextEncoder().encode("seclettr.group-call.frame:test")
    );

    expect(new TextDecoder().decode(decrypted)).toBe("legacy-frame");
  });

  describe("processFrameBuffer fail-closed behavior", () => {
    const additionalData = new TextEncoder().encode("seclettr.group-call.frame:test");

    it("drops send frames instead of emitting plaintext when no key is armed in required mode", async () => {
      const plaintext = new TextEncoder().encode("must-not-leak");
      const output = await processFrameBuffer(plaintext.buffer.slice(0), {
        direction: "send",
        additionalData,
        keyStates: [],
        requireEncryption: true,
      });

      expect(output).toBeNull();
    });

    it("drops received cleartext frames in required mode", async () => {
      const cleartext = new TextEncoder().encode("downgrade-attempt");
      const output = await processFrameBuffer(cleartext.buffer.slice(0), {
        direction: "recv",
        additionalData,
        keyStates: normalizeKeyInput(crypto.getRandomValues(new Uint8Array(32))),
        requireEncryption: true,
      });

      expect(output).toBeNull();
    });

    it("still passes through cleartext in best-effort mode", async () => {
      const cleartext = new TextEncoder().encode("legacy-passthrough");
      const output = await processFrameBuffer(cleartext.buffer.slice(0), {
        direction: "recv",
        additionalData,
        keyStates: [],
        requireEncryption: false,
      });

      expect(output).not.toBeNull();
      expect(new TextDecoder().decode(output!)).toBe("legacy-passthrough");
    });
  });

  it("decrypts with the previous key context after media-key rotation", async () => {
    const currentKey = crypto.getRandomValues(new Uint8Array(32));
    const previousKey = crypto.getRandomValues(new Uint8Array(32));
    const additionalData = new TextEncoder().encode("seclettr.group-call.frame:test");
    const plaintext = new TextEncoder().encode("rotated-frame");

    const encrypted = await encryptGroupCallFrame(plaintext, previousKey, additionalData);
    const decrypted = await decryptGroupCallFrameWithKeyContexts(
      encrypted,
      [
        { keyId: "key-current", epoch: 2, keyBytes: currentKey },
        { keyId: "key-previous", epoch: 1, keyBytes: previousKey },
      ],
      additionalData
    );

    expect(new TextDecoder().decode(decrypted)).toBe("rotated-frame");
  });

  it("accepts SDFEP wrapped frames during mixed-version rollout", async () => {
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const additionalData = new TextEncoder().encode("seclettr.group-call.frame:test");
    const plaintext = new TextEncoder().encode("sdfep-wrapped-frame");
    const encrypted = await encryptGroupCallFrame(plaintext, keyBytes, additionalData);
    const sdfepEncrypted = Uint8Array.from(encrypted);
    sdfepEncrypted.set([0x53, 0x44, 0x46, 0x45, 0x50], 0);

    const decrypted = await decryptGroupCallFrame(sdfepEncrypted, keyBytes, additionalData);

    expect(new TextDecoder().decode(decrypted)).toBe("sdfep-wrapped-frame");
  });

  it("keeps frame stream passthrough after sender handle close", async () => {
    const input = new TransformStream<{ data: ArrayBuffer }, { data: ArrayBuffer }>();
    const output = new TransformStream<{ data: ArrayBuffer }, { data: ArrayBuffer }>();

    const sender = {
      createEncodedStreams: () => ({
        readable: input.readable,
        writable: output.writable,
      }),
    };

    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const handle = bindSenderFrameEncryption(
      sender as unknown as RTCRtpSender,
      {
        roomId: "room-1",
        deviceId: "device-1",
        kind: "video",
      },
      keyBytes
    );

    const writer = input.writable.getWriter();
    const reader = output.readable.getReader();

    const firstPlaintext = new TextEncoder().encode("frame-1");
    await writer.write({ data: firstPlaintext.buffer.slice(0) });
    const firstOutput = await reader.read();
    expect(firstOutput.done).toBe(false);
    expect(new Uint8Array(firstOutput.value!.data)).not.toEqual(firstPlaintext);

    handle.close();

    const secondPlaintext = new TextEncoder().encode("frame-2");
    await writer.write({ data: secondPlaintext.buffer.slice(0) });
    const secondOutput = await reader.read();
    expect(secondOutput.done).toBe(false);
    expect(new Uint8Array(secondOutput.value!.data)).toEqual(secondPlaintext);

    await writer.close();
    reader.releaseLock();
    writer.releaseLock();
  });

  it("returns unsupported handle when createEncodedStreams throws", () => {
    const sender = {
      createEncodedStreams: () => {
        throw new Error("Too late to create encoded streams");
      },
    };

    const handle = bindSenderFrameEncryption(
      sender as unknown as RTCRtpSender,
      {
        roomId: "room-1",
        deviceId: "device-1",
        kind: "video",
      },
      null
    );

    expect(handle.supported).toBe(false);
    expect(() => handle.setKeyBytes(new Uint8Array([1, 2, 3]))).not.toThrow();
    expect(() => handle.close()).not.toThrow();
  });

  it("marks the handle as failed and calls onPipelineFailed when the encoded-streams pipeline dies", async () => {
    const sender = {
      createEncodedStreams: () => ({
        readable: new ReadableStream<{ data: ArrayBuffer }>({
          start(controller) {
            controller.error(new Error("pipeline failed"));
          },
        }),
        writable: new WritableStream<{ data: ArrayBuffer }>(),
      }),
    };
    const onPipelineFailed = vi.fn();

    const handle = bindSenderFrameEncryption(
      sender as unknown as RTCRtpSender,
      {
        roomId: "room-failed",
        deviceId: "device-failed",
        kind: "audio",
      },
      crypto.getRandomValues(new Uint8Array(32)),
      onPipelineFailed
    );

    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(onPipelineFailed).toHaveBeenCalledTimes(1);
    expect(handle.failed).toBe(true);
  });

  it("binds frame crypto through RTCRtpScriptTransform when legacy encoded streams are unavailable", () => {
    const workerMessages: unknown[] = [];
    const workerInstances: Array<{ postMessage: Mock<any[], unknown>; terminate: Mock<any[], unknown> }> = [];

    class MockWorker {
      listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

      postMessage: Mock<any[], unknown> = vi.fn<any[], unknown>((message: unknown) => {
        workerMessages.push(message);
      });

      terminate: Mock<any[], unknown> = vi.fn<any[], unknown>();

      addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }

      removeEventListener(type: string, listener: (event: { data?: unknown }) => void) {
        this.listeners.set(
          type,
          (this.listeners.get(type) ?? []).filter((entry) => entry !== listener)
        );
      }

      constructor(_url: URL | string, _options?: WorkerOptions) {
        workerInstances.push(this);
      }
    }

    class MockScriptTransform {
      constructor(
        public readonly worker: Worker,
        public readonly options?: unknown
      ) {}
    }

    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("Worker", MockWorker);
    Object.defineProperty(globalThis, "RTCRtpScriptTransform", {
      configurable: true,
      writable: true,
      value: MockScriptTransform,
    });

    const sender = {
      transform: null as unknown,
    };

    const handle = bindSenderFrameEncryption(
      sender as unknown as RTCRtpSender,
      {
        roomId: "room-script",
        deviceId: "device-script",
        kind: "video",
      },
      new Uint8Array([7, 8, 9])
    );

    expect(handle.supported).toBe(true);
    expect(sender.transform).toBeInstanceOf(MockScriptTransform);
    expect(workerInstances).toHaveLength(1);
    expect(workerMessages).toHaveLength(1);
    expect(workerMessages[0]).toMatchObject({
      type: "configure",
      direction: "send",
      context: {
        roomId: "room-script",
        deviceId: "device-script",
        kind: "video",
      },
    });

    handle.close();

    expect(sender.transform).toBeUndefined();
    expect(workerMessages[1]).toMatchObject({
      type: "close",
    });
    expect(workerInstances[0]?.terminate).toHaveBeenCalledTimes(1);
  });

  it("falls back to RTCRtpScriptTransform when createEncodedStreams exists but throws", () => {
    const workerMessages: unknown[] = [];

    class MockWorker {
      listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

      postMessage = vi.fn((message: unknown) => {
        workerMessages.push(message);
      });

      terminate = vi.fn();

      addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }

      removeEventListener(type: string, listener: (event: { data?: unknown }) => void) {
        this.listeners.set(
          type,
          (this.listeners.get(type) ?? []).filter((entry) => entry !== listener)
        );
      }

      constructor(_url: URL | string, _options?: WorkerOptions) {}
    }

    class MockScriptTransform {
      constructor(
        public readonly worker: Worker,
        public readonly options?: unknown
      ) {}
    }

    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("Worker", MockWorker);
    Object.defineProperty(globalThis, "RTCRtpScriptTransform", {
      configurable: true,
      writable: true,
      value: MockScriptTransform,
    });

    const sender = {
      createEncodedStreams: () => {
        throw new Error("Too late to create encoded streams");
      },
      transform: null as unknown,
    };

    const handle = bindSenderFrameEncryption(
      sender as unknown as RTCRtpSender,
      {
        roomId: "room-script-fallback",
        deviceId: "device-script-fallback",
        kind: "audio",
      },
      new Uint8Array([4, 5, 6])
    );

    expect(handle.supported).toBe(true);
    expect(sender.transform).toBeInstanceOf(MockScriptTransform);
    expect(workerMessages[0]).toMatchObject({
      type: "configure",
      direction: "send",
      context: {
        roomId: "room-script-fallback",
        deviceId: "device-script-fallback",
        kind: "audio",
      },
    });
  });

  it("marks the script-transform handle as failed when the worker reports a pipeline error", () => {
    let workerInstance: {
      listeners: Map<string, Array<(event: { data?: unknown }) => void>>;
      terminate: Mock<any[], unknown>;
    } | null = null;
    const onPipelineFailed = vi.fn();

    class MockWorker {
      listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
      postMessage = vi.fn();
      terminate = vi.fn();

      addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }

      removeEventListener(type: string, listener: (event: { data?: unknown }) => void) {
        this.listeners.set(
          type,
          (this.listeners.get(type) ?? []).filter((entry) => entry !== listener)
        );
      }

      constructor(_url: URL | string, _options?: WorkerOptions) {
        workerInstance = this;
      }
    }

    class MockScriptTransform {
      constructor(
        public readonly worker: Worker,
        public readonly options?: unknown
      ) {}
    }

    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("Worker", MockWorker);
    Object.defineProperty(globalThis, "RTCRtpScriptTransform", {
      configurable: true,
      writable: true,
      value: MockScriptTransform,
    });

    const sender = {
      transform: null as unknown,
    };

    const handle = bindSenderFrameEncryption(
      sender as unknown as RTCRtpSender,
      {
        roomId: "room-script-error",
        deviceId: "device-script-error",
        kind: "video",
        source: "camera",
      },
      new Uint8Array([1, 2, 3]),
      onPipelineFailed
    );

    expect(workerInstance).not.toBeNull();
    const activeWorker = workerInstance as unknown as {
      listeners: Map<string, Array<(event: { data?: unknown }) => void>>;
      terminate: Mock<any[], unknown>;
    };
    const listeners = activeWorker.listeners.get("message") ?? [];
    for (const listener of listeners) {
      listener({
        data: {
          type: "pipeline-failed",
          handleId: (
            sender.transform as {
              options?: { handleId?: string };
            }
          ).options?.handleId,
        },
      });
    }

    expect(handle.failed).toBe(true);
    expect(onPipelineFailed).toHaveBeenCalledTimes(1);
    expect(sender.transform).toBeUndefined();
    expect(activeWorker.terminate).toHaveBeenCalledTimes(1);
  });
});
