/**
 * useDirectCallFrameCryptoRuntime — frame-level encryption lifecycle for 1:1 calls.
 *
 * Owns:
 *   - local ephemeral key preparation (ECDH keypair generated once per call)
 *   - peer ephemeral public key ingestion
 *   - sender frame encryption handle binding per RTCRtpSender (camera / screen)
 *   - receiver frame decryption handle binding per RTCRtpReceiver
 *   - frame crypto state configuration and mode negotiation (frame-v1 → transport fallback)
 *   - cleanup on call teardown via closeDirectCallFrameCrypto
 *
 * Does not own the negotiation protocol, signal dispatch, or peer-connection
 * bootstrap. Crypto keys are derived in direct-call-frame-crypto.ts; this
 * hook manages their lifecycle inside the call runtime.
 */
import { useCallback, useRef, type MutableRefObject } from "react";
import {
  detectLocalDirectCallMediaEncryptionModes,
  type DirectCallMediaEncryptionMode,
} from "@/calls/direct/model/call-media-encryption-negotiation";
import { loadPeerIdentityPublicKey } from "@/calls/direct/runtime/crypto/call-auth-store";
import { deriveDirectCallFrameKeys } from "@/calls/direct/runtime/crypto/direct-call-frame-crypto";
import { ensureSodium, toBase64Url, fromBase64Url } from "@seclettr/crypto";
import {
  bindReceiverFrameDecryption,
  bindSenderFrameEncryption,
  type GroupCallFrameCryptoHandle,
} from "@/calls/shared/crypto/frame-crypto";
import { useAuthStore } from "@/stores/auth";
import type { DirectCallFrameCryptoState } from "@/calls/direct/model/direct-call-types";
import {
  createEmptyDirectCallSenderFrameHandles,
  resolveDirectCallSenderFrameHandleAction,
  type DirectCallSenderFrameHandles,
} from "@/calls/direct/runtime/direct-call-frame-crypto-runtime";

type DebugCallMedia = (event: string, payload: Record<string, unknown>) => void;
type LocalEphemeralKeyState = { callId: string; privateKey: Uint8Array };
type PeerEphemeralKeyState = { callId: string; publicKeyBytes: Uint8Array };

interface UseDirectCallFrameCryptoRuntimeOptions {
  peerConnectionRef: MutableRefObject<RTCPeerConnection | null>;
  cameraSenderRef: MutableRefObject<RTCRtpSender | null>;
  screenShareSenderRef: MutableRefObject<RTCRtpSender | null>;
  directCallFrameCryptoStateRef: MutableRefObject<DirectCallFrameCryptoState | null>;
  directCallSenderFrameHandlesRef: MutableRefObject<DirectCallSenderFrameHandles>;
  directCallReceiverFrameHandlesRef: MutableRefObject<Map<RTCRtpReceiver, GroupCallFrameCryptoHandle>>;
  debugCallMedia: DebugCallMedia;
}

function resolveFrameCryptoAuthContext() {
  const auth = useAuthStore.getState();
  if (!auth.userId || !auth.deviceId || !auth.identityDhKeyPair) {
    return null;
  }

  return {
    userId: auth.userId,
    deviceId: auth.deviceId,
    identityPrivateKey: auth.identityDhKeyPair.privateKey,
  };
}

function getMatchingLocalEphemeralKey(
  ref: MutableRefObject<LocalEphemeralKeyState | null>,
  callId: string
): LocalEphemeralKeyState | null {
  return ref.current?.callId === callId ? ref.current : null;
}

function getMatchingPeerEphemeralKey(
  ref: MutableRefObject<PeerEphemeralKeyState | null>,
  callId: string
): PeerEphemeralKeyState | null {
  return ref.current?.callId === callId ? ref.current : null;
}

function bindExistingDirectCallReceivers(
  pc: RTCPeerConnection | null,
  callId: string,
  ensureReceiverBound: (
    callId: string,
    receiver: RTCRtpReceiver,
    kind: "audio" | "video"
  ) => void
): void {
  if (!pc) return;

  for (const receiver of pc.getReceivers()) {
    if (receiver.track?.kind === "audio") {
      ensureReceiverBound(callId, receiver, "audio");
    } else if (receiver.track?.kind === "video") {
      ensureReceiverBound(callId, receiver, "video");
    }
  }
}

export function useDirectCallFrameCryptoRuntime({
  peerConnectionRef,
  cameraSenderRef,
  screenShareSenderRef,
  directCallFrameCryptoStateRef,
  directCallSenderFrameHandlesRef,
  directCallReceiverFrameHandlesRef,
  debugCallMedia,
}: UseDirectCallFrameCryptoRuntimeOptions) {
  // Per-call ephemeral DH state. Both refs are zeroed and cleared after key
  // derivation (or on call close) so private key material never lingers.
  const localEphemeralRef = useRef<{ callId: string; privateKey: Uint8Array } | null>(null);
  const peerEphemeralRef = useRef<{ callId: string; publicKeyBytes: Uint8Array } | null>(null);

  const clearEphemeralState = useCallback(() => {
    if (localEphemeralRef.current) {
      localEphemeralRef.current.privateKey.fill(0);
      localEphemeralRef.current = null;
    }
    peerEphemeralRef.current = null;
  }, []);

  /**
   * Generates a fresh X25519 ephemeral key pair for the given call and stores
   * the private key in a ref. Returns the public key as a base64url string to
   * include in the outbound offer or answer's mediaEncryption field.
   */
  const prepareLocalEphemeralKey = useCallback(async (callId: string): Promise<string> => {
    // Discard any previous ephemeral state (e.g. if call was retried).
    clearEphemeralState();
    const sodium = await ensureSodium();
    const keyPair = sodium.crypto_box_keypair();
    localEphemeralRef.current = { callId, privateKey: keyPair.privateKey };
    return toBase64Url(keyPair.publicKey);
  }, [clearEphemeralState]);

  /**
   * Stores the peer's ephemeral public key for use in key derivation.
   * Called after receiving an offer or answer that carries an ephemeralPublicKey.
   */
  const setPeerEphemeralPublicKey = useCallback((callId: string, pubKeyBase64: string | null | undefined): void => {
    if (!pubKeyBase64) {
      peerEphemeralRef.current = null;
      return;
    }
    try {
      const publicKeyBytes = fromBase64Url(pubKeyBase64);
      if (publicKeyBytes.length !== 32) {
        peerEphemeralRef.current = null;
        return;
      }
      peerEphemeralRef.current = { callId, publicKeyBytes };
    } catch {
      peerEphemeralRef.current = null;
    }
  }, []);

  const closeDirectCallFrameCrypto = useCallback(() => {
    const senderHandles = directCallSenderFrameHandlesRef.current;
    const receiverHandleCount = directCallReceiverFrameHandlesRef.current.size;
    for (const slot of ["audio", "camera", "screen"] as const) {
      senderHandles[slot].handle?.close();
    }
    directCallSenderFrameHandlesRef.current = createEmptyDirectCallSenderFrameHandles();

    for (const handle of directCallReceiverFrameHandlesRef.current.values()) {
      handle.close();
    }
    directCallReceiverFrameHandlesRef.current.clear();
    // Zero derived media keys before dropping the reference so plaintext key
    // material does not linger in the heap after teardown (AUDIT.md H8).
    const cryptoState = directCallFrameCryptoStateRef.current;
    if (cryptoState) {
      cryptoState.sendKeyBytes.fill(0);
      cryptoState.recvKeyBytes.fill(0);
    }
    directCallFrameCryptoStateRef.current = null;
    clearEphemeralState();
    debugCallMedia("frame-crypto-closed", {
      senderSlots: ["audio", "camera", "screen"],
      receiverHandleCount,
    });
  }, [
    clearEphemeralState,
    debugCallMedia,
    directCallFrameCryptoStateRef,
    directCallReceiverFrameHandlesRef,
    directCallSenderFrameHandlesRef,
  ]);

  // Empty deps are intentional: useAuthStore.getState() reads the current store
  // value imperatively at call time, not reactively — no closure over stale state.
  const resolveLocalSupportedMediaEncryptionModes = useCallback((): DirectCallMediaEncryptionMode[] => {
    const detectedModes = detectLocalDirectCallMediaEncryptionModes();
    const auth = useAuthStore.getState();
    const frameKeyMaterialReady = Boolean(
      auth.userId &&
      auth.deviceId &&
      auth.identityDhKeyPair?.privateKey &&
      auth.identityDhKeyPair.privateKey.length > 0
    );
    if (frameKeyMaterialReady) {
      return detectedModes;
    }
    return detectedModes.filter((mode) => mode !== "frame-v1");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bindOrRefreshDirectCallSenderFrameCrypto = useCallback((params: {
    callId: string;
    localUserId: string;
    localDeviceId: string;
    keyBytes: Uint8Array | null;
  }): boolean => {
    const pc = peerConnectionRef.current;
    if (!pc) return false;

    const senderContext = {
      roomId: params.callId,
      deviceId: `${params.localUserId}:${params.localDeviceId}`,
    };
    const senderHandles = directCallSenderFrameHandlesRef.current;
    const senderKeyBytes = params.keyBytes ? Uint8Array.from(params.keyBytes) : null;

    const bindOrUpdate = (
      slot: "audio" | "camera" | "screen",
      sender: RTCRtpSender | null,
      kind: "audio" | "video"
    ): boolean => {
      const binding = senderHandles[slot];
      const action = resolveDirectCallSenderFrameHandleAction(binding, sender);
      if (action === "noop") {
        return true;
      }
      if (action === "detach") {
        binding.handle?.close();
        binding.handle = null;
        binding.sender = null;
        debugCallMedia("frame-crypto-sender-detached", {
          callId: params.callId,
          slot,
          kind,
        });
        return true;
      }
      if (action === "refresh") {
        binding.handle?.setKeyBytes(senderKeyBytes);
        debugCallMedia("frame-crypto-sender-refreshed", {
          callId: params.callId,
          slot,
          kind,
          senderTrackKind: sender?.track?.kind ?? null,
        });
        return binding.handle?.supported ?? false;
      }
      if (!sender) {
        return true;
      }
      binding.handle?.close();
      const nextHandle = bindSenderFrameEncryption(
        sender,
        { ...senderContext, kind },
        senderKeyBytes,
        () => {
          debugCallMedia("frame-crypto-sender-pipeline-failed", {
            callId: params.callId,
            slot,
            kind,
          });
        },
        // frame-v1 is an explicitly negotiated E2EE mode, so the pipeline is
        // fail-closed: never emit a plaintext frame (see AUDIT.md C4).
        true
      );
      binding.handle = nextHandle;
      binding.sender = sender;
      debugCallMedia(action === "rebind" ? "frame-crypto-sender-rebound" : "frame-crypto-sender-bound", {
        callId: params.callId,
        slot,
        kind,
        senderTrackKind: sender.track?.kind ?? null,
        supported: nextHandle.supported,
      });
      return nextHandle.supported;
    };

    const audioSender = pc.getSenders().find((sender) => sender.track?.kind === "audio") ?? null;
    const audioSupported = bindOrUpdate("audio", audioSender, "audio");
    const cameraSupported = bindOrUpdate("camera", cameraSenderRef.current, "video");

    let screenSupported = true;
    if (
      screenShareSenderRef.current &&
      screenShareSenderRef.current !== cameraSenderRef.current
    ) {
      screenSupported = bindOrUpdate("screen", screenShareSenderRef.current, "video");
    }

    return audioSupported && cameraSupported && screenSupported;
  }, [
    cameraSenderRef,
    debugCallMedia,
    directCallSenderFrameHandlesRef,
    peerConnectionRef,
    screenShareSenderRef,
  ]);

  const ensureDirectCallSenderFrameCryptoBound = useCallback((callId: string): boolean => {
    const state = directCallFrameCryptoStateRef.current;
    if (state?.callId !== callId) return false;

    return bindOrRefreshDirectCallSenderFrameCrypto({
      callId,
      localUserId: state.localUserId,
      localDeviceId: state.localDeviceId,
      keyBytes: state.sendKeyBytes,
    });
  }, [bindOrRefreshDirectCallSenderFrameCrypto, directCallFrameCryptoStateRef]);

  const primeDirectCallSenderFrameCrypto = useCallback((callId: string): boolean => {
    const auth = useAuthStore.getState();
    if (!auth.userId || !auth.deviceId) {
      return false;
    }
    return bindOrRefreshDirectCallSenderFrameCrypto({
      callId,
      localUserId: auth.userId,
      localDeviceId: auth.deviceId,
      keyBytes: null,
    });
  }, [bindOrRefreshDirectCallSenderFrameCrypto]);

  const ensureDirectCallReceiverFrameCryptoBound = useCallback((
    callId: string,
    receiver: RTCRtpReceiver,
    kind: "audio" | "video"
  ) => {
    const state = directCallFrameCryptoStateRef.current;
    if (state?.callId !== callId) return;

    const handles = directCallReceiverFrameHandlesRef.current;
    const existing = handles.get(receiver);
    if (existing) {
      existing.setKeyBytes(state.recvKeyBytes);
      return;
    }

    const handle = bindReceiverFrameDecryption(
      receiver,
      {
        roomId: callId,
        deviceId: `${state.peerUserId}:${state.peerDeviceId}`,
        kind,
      },
      state.recvKeyBytes,
      () => {
        debugCallMedia("frame-crypto-receiver-pipeline-failed", {
          callId,
          kind,
        });
      },
      // Negotiated frame-v1 is fail-closed: reject cleartext frames rather than
      // accepting a downgrade (see AUDIT.md C4).
      true
    );
    handles.set(receiver, handle);
    debugCallMedia("frame-crypto-receiver-bound", {
      callId,
      kind,
      supported: handle.supported,
    });
  }, [debugCallMedia, directCallFrameCryptoStateRef, directCallReceiverFrameHandlesRef]);

  const configureDirectCallFrameCrypto = useCallback(async (params: {
    callId: string;
    mediaEncryptionMode: DirectCallMediaEncryptionMode;
    peerUserId: string;
    peerDeviceId: string | null;
  }): Promise<boolean> => {
    if (params.mediaEncryptionMode !== "frame-v1") {
      closeDirectCallFrameCrypto();
      return true;
    }
    if (!params.peerDeviceId) {
      return false;
    }

    const auth = resolveFrameCryptoAuthContext();
    if (!auth) {
      return false;
    }

    const existingState = directCallFrameCryptoStateRef.current;
    if (
      existingState &&
      existingState.callId !== params.callId
    ) {
      closeDirectCallFrameCrypto();
    }

    const peerIdentityPublicKey = await loadPeerIdentityPublicKey(params.peerUserId, params.peerDeviceId);
    if (!peerIdentityPublicKey) {
      return false;
    }

    // Use ephemeral keys for forward secrecy when both sides have provided them
    // for this specific call. Falls back to identity-key derivation (v1) if either
    // side did not include an ephemeral key in their offer/answer.
    const localEphemeral = getMatchingLocalEphemeralKey(
      localEphemeralRef,
      params.callId
    );
    const peerEphemeral = getMatchingPeerEphemeralKey(
      peerEphemeralRef,
      params.callId
    );

    const keyMaterial = await deriveDirectCallFrameKeys({
      callId: params.callId,
      localUserId: auth.userId,
      localDeviceId: auth.deviceId,
      localIdentityPrivateKey: auth.identityPrivateKey,
      peerUserId: params.peerUserId,
      peerDeviceId: params.peerDeviceId,
      peerIdentityPublicKey,
      // Pass ephemeral keys only when both are available; deriveDirectCallFrameKeys
      // zeros localEphemeralPrivateKey immediately after the DH operation.
      localEphemeralPrivateKey: localEphemeral?.privateKey,
      peerEphemeralPublicKey: peerEphemeral?.publicKeyBytes,
    });

    // The local ephemeral private key was zeroed inside deriveDirectCallFrameKeys;
    // clear the ref so the zeroed buffer is not accidentally reused.
    clearEphemeralState();

    directCallFrameCryptoStateRef.current = {
      callId: params.callId,
      localUserId: auth.userId,
      localDeviceId: auth.deviceId,
      peerUserId: params.peerUserId,
      peerDeviceId: params.peerDeviceId,
      sendKeyBytes: keyMaterial.sendKeyBytes,
      recvKeyBytes: keyMaterial.recvKeyBytes,
    };
    debugCallMedia("frame-crypto-configured", {
      callId: params.callId,
      mediaEncryptionMode: params.mediaEncryptionMode,
      peerUserId: params.peerUserId,
      peerDeviceId: params.peerDeviceId,
      forwardSecure: keyMaterial.forwardSecure,
    });
    const senderFrameCryptoReady = ensureDirectCallSenderFrameCryptoBound(params.callId);
    if (!senderFrameCryptoReady) {
      debugCallMedia("frame-crypto-sender-unsupported", {
        callId: params.callId,
        mediaEncryptionMode: params.mediaEncryptionMode,
      });
      return false;
    }

    bindExistingDirectCallReceivers(
      peerConnectionRef.current,
      params.callId,
      ensureDirectCallReceiverFrameCryptoBound
    );
    return true;
  }, [
    clearEphemeralState,
    closeDirectCallFrameCrypto,
    debugCallMedia,
    directCallFrameCryptoStateRef,
    ensureDirectCallReceiverFrameCryptoBound,
    ensureDirectCallSenderFrameCryptoBound,
    peerConnectionRef,
  ]);

  return {
    closeDirectCallFrameCrypto,
    resolveLocalSupportedMediaEncryptionModes,
    ensureDirectCallSenderFrameCryptoBound,
    primeDirectCallSenderFrameCrypto,
    ensureDirectCallReceiverFrameCryptoBound,
    configureDirectCallFrameCrypto,
    prepareLocalEphemeralKey,
    setPeerEphemeralPublicKey,
  };
}
