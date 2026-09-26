import { describe, expect, it } from "vitest";
import {
  WS_PROTOCOL_VERSION,
  WsClientMessageSchema,
  WsServerMessageSchema,
} from "../websocket.js";

function wsClient(payload: Record<string, unknown>) {
  return WsClientMessageSchema.safeParse({
    version: WS_PROTOCOL_VERSION,
    ...payload,
  });
}

function wsServer(payload: Record<string, unknown>) {
  return WsServerMessageSchema.safeParse({
    version: WS_PROTOCOL_VERSION,
    ...payload,
  });
}

describe("WebSocket metadata contracts", () => {
  it("accepts read + typing client events", () => {
    const read = wsClient({
      type: "message.read",
      messageId: crypto.randomUUID(),
    });
    expect(read.success).toBe(true);

    const typingStart = wsClient({
      type: "typing.start",
      targetUserId: crypto.randomUUID(),
      chatKind: "e2ee",
    });
    expect(typingStart.success).toBe(true);

    const typingStop = wsClient({
      type: "typing.stop",
      targetUserId: crypto.randomUUID(),
      chatKind: "e2ee",
    });
    expect(typingStop.success).toBe(true);

    const iceBatch = wsClient({
      type: "call.ice.batch",
      callId: crypto.randomUUID(),
      candidates: [
        JSON.stringify({
          candidate: "candidate:1 1 udp 1 127.0.0.1 9 typ host",
        }),
      ],
    });
    expect(iceBatch.success).toBe(true);

    const callOffer = wsClient({
      type: "call.offer",
      callId: crypto.randomUUID(),
      targetUserId: crypto.randomUUID(),
      sdp: "v=0\r\ns=-",
      callType: "audio",
      chatKind: "plain",
      features: {
        renegotiationV1: true,
      },
      mediaEncryption: {
        preferredMode: "transport",
        supportedModes: ["transport"],
      },
      auth: {
        version: 1,
        senderUserId: crypto.randomUUID(),
        senderDeviceId: crypto.randomUUID(),
        recipientUserId: crypto.randomUUID(),
        signedAt: new Date().toISOString(),
        sdpHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        signature: "sig",
      },
    });
    expect(callOffer.success).toBe(true);

    const callAnswer = wsClient({
      type: "call.answer",
      callId: crypto.randomUUID(),
      sdp: "v=0\r\ns=-",
      features: {
        renegotiationV1: true,
      },
      mediaEncryption: {
        selectedMode: "transport",
        supportedModes: ["transport"],
      },
      auth: {
        version: 1,
        senderUserId: crypto.randomUUID(),
        senderDeviceId: crypto.randomUUID(),
        recipientUserId: crypto.randomUUID(),
        signedAt: new Date().toISOString(),
        sdpHash: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        signature: "sig",
      },
    });
    expect(callAnswer.success).toBe(true);

    const renegotiationOffer = wsClient({
      type: "call.renegotiate.offer",
      callId: crypto.randomUUID(),
      revision: 1,
      sdp: "v=0\r\ns=-",
      auth: {
        version: 1,
        senderUserId: crypto.randomUUID(),
        senderDeviceId: crypto.randomUUID(),
        recipientUserId: crypto.randomUUID(),
        signedAt: new Date().toISOString(),
        sdpHash: "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
        signature: "sig",
      },
    });
    expect(renegotiationOffer.success).toBe(true);

    const renegotiationAnswer = wsClient({
      type: "call.renegotiate.answer",
      callId: crypto.randomUUID(),
      revision: 1,
      sdp: "v=0\r\ns=-",
      auth: {
        version: 1,
        senderUserId: crypto.randomUUID(),
        senderDeviceId: crypto.randomUUID(),
        recipientUserId: crypto.randomUUID(),
        signedAt: new Date().toISOString(),
        sdpHash: "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
        signature: "sig",
      },
    });
    expect(renegotiationAnswer.success).toBe(true);

    const roomJoin = wsClient({
      type: "room.join",
      roomId: crypto.randomUUID(),
      rtpCapabilities: JSON.stringify({ codecs: [] }),
    });
    expect(roomJoin.success).toBe(true);

    const roomLeave = wsClient({
      type: "room.leave",
      roomId: crypto.randomUUID(),
    });
    expect(roomLeave.success).toBe(true);

    const mediaKey = wsClient({
      type: "group.call.media-key",
      callId: crypto.randomUUID(),
      targetDeviceId: crypto.randomUUID(),
      epoch: 1,
      keyId: "sender-key-1",
      algorithm: "aes-256-gcm",
      encryptedKey: "v1.ciphertext",
    });
    expect(mediaKey.success).toBe(true);

    const mediaKeyAck = wsClient({
      type: "group.call.media-key.ack",
      callId: crypto.randomUUID(),
      targetDeviceId: crypto.randomUUID(),
      epoch: 1,
      keyId: "sender-key-1",
    });
    expect(mediaKeyAck.success).toBe(true);

    const callMediaState = wsClient({
      type: "call.media_state",
      callId: crypto.randomUUID(),
      source: "camera",
      state: "off",
      activity: "inactive",
      seq: 3,
      streamRevision: 2,
      reason: "user-toggle",
    });
    expect(callMediaState.success).toBe(true);

    const mediaMode = wsClient({
      type: "group.call.media-mode",
      callId: crypto.randomUUID(),
      mode: "best-effort",
    });
    expect(mediaMode.success).toBe(true);

    const producerState = wsClient({
      type: "group.call.producer_state",
      callId: crypto.randomUUID(),
      producerId: "producer-1",
      kind: "video",
      source: "screen",
      state: "added",
    });
    expect(producerState.success).toBe(true);
  });

  it("accepts read + typing + presence server events", () => {
    const deliveredReceipt = wsServer({
      type: "message.delivered",
      messageId: crypto.randomUUID(),
      clientMessageId: crypto.randomUUID(),
    });
    expect(deliveredReceipt.success).toBe(true);

    const readReceipt = wsServer({
      type: "message.read",
      messageId: crypto.randomUUID(),
      clientMessageId: crypto.randomUUID(),
      readerUserId: crypto.randomUUID(),
      readerDeviceId: crypto.randomUUID(),
      readAt: new Date().toISOString(),
    });
    expect(readReceipt.success).toBe(true);

    const typingStart = wsServer({
      type: "typing.start",
      senderUserId: crypto.randomUUID(),
      senderDeviceId: crypto.randomUUID(),
      chatKind: "e2ee",
    });
    expect(typingStart.success).toBe(true);

    const typingStop = wsServer({
      type: "typing.stop",
      senderUserId: crypto.randomUUID(),
      senderDeviceId: crypto.randomUUID(),
      chatKind: "e2ee",
    });
    expect(typingStop.success).toBe(true);

    const presence = wsServer({
      type: "presence.update",
      userId: crypto.randomUUID(),
      online: false,
      lastSeenAt: new Date().toISOString(),
    });
    expect(presence.success).toBe(true);

    const iceBatch = wsServer({
      type: "call.ice.batch",
      callId: crypto.randomUUID(),
      candidates: [
        JSON.stringify({
          candidate: "candidate:1 1 udp 1 127.0.0.1 9 typ host",
        }),
      ],
    });
    expect(iceBatch.success).toBe(true);

    const callOffer = wsServer({
      type: "call.offer",
      callId: crypto.randomUUID(),
      callerUserId: crypto.randomUUID(),
      callerDeviceId: crypto.randomUUID(),
      targetUserId: crypto.randomUUID(),
      sdp: "v=0\r\ns=-",
      callType: "video",
      chatKind: "plain",
      features: {
        renegotiationV1: true,
      },
      mediaEncryption: {
        preferredMode: "transport",
        supportedModes: ["transport"],
      },
      auth: {
        version: 1,
        senderUserId: crypto.randomUUID(),
        senderDeviceId: crypto.randomUUID(),
        recipientUserId: crypto.randomUUID(),
        signedAt: new Date().toISOString(),
        sdpHash: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
        signature: "sig",
      },
    });
    expect(callOffer.success).toBe(true);

    const callAnswered = wsServer({
      type: "call.answered",
      callId: crypto.randomUUID(),
      answererUserId: crypto.randomUUID(),
      answererDeviceId: crypto.randomUUID(),
      targetUserId: crypto.randomUUID(),
      sdp: "v=0\r\ns=-",
      features: {
        renegotiationV1: true,
      },
      mediaEncryption: {
        selectedMode: "transport",
        supportedModes: ["transport"],
      },
      auth: {
        version: 1,
        senderUserId: crypto.randomUUID(),
        senderDeviceId: crypto.randomUUID(),
        recipientUserId: crypto.randomUUID(),
        signedAt: new Date().toISOString(),
        sdpHash: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
        signature: "sig",
      },
    });
    expect(callAnswered.success).toBe(true);

    const renegotiationOffer = wsServer({
      type: "call.renegotiate.offer",
      callId: crypto.randomUUID(),
      revision: 2,
      senderUserId: crypto.randomUUID(),
      senderDeviceId: crypto.randomUUID(),
      sdp: "v=0\r\ns=-",
      auth: {
        version: 1,
        senderUserId: crypto.randomUUID(),
        senderDeviceId: crypto.randomUUID(),
        recipientUserId: crypto.randomUUID(),
        signedAt: new Date().toISOString(),
        sdpHash: "GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG",
        signature: "sig",
      },
    });
    expect(renegotiationOffer.success).toBe(true);

    const renegotiationAnswer = wsServer({
      type: "call.renegotiate.answer",
      callId: crypto.randomUUID(),
      revision: 2,
      senderUserId: crypto.randomUUID(),
      senderDeviceId: crypto.randomUUID(),
      sdp: "v=0\r\ns=-",
      auth: {
        version: 1,
        senderUserId: crypto.randomUUID(),
        senderDeviceId: crypto.randomUUID(),
        recipientUserId: crypto.randomUUID(),
        signedAt: new Date().toISOString(),
        sdpHash: "HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH",
        signature: "sig",
      },
    });
    expect(renegotiationAnswer.success).toBe(true);

    const callMediaState = wsServer({
      type: "call.media_state",
      callId: crypto.randomUUID(),
      senderUserId: crypto.randomUUID(),
      senderDeviceId: crypto.randomUUID(),
      source: "screen",
      state: "ended",
      activity: "inactive",
      seq: 8,
      streamRevision: 4,
      reason: "track-ended",
      changedAt: new Date().toISOString(),
    });
    expect(callMediaState.success).toBe(true);

    const groupCallStarted = wsServer({
      type: "group.call.started",
      groupId: crypto.randomUUID(),
      callId: crypto.randomUUID(),
      callType: "video",
      callerUserId: crypto.randomUUID(),
      startedAt: new Date().toISOString(),
    });
    expect(groupCallStarted.success).toBe(true);

    const groupCallMediaMode = wsServer({
      type: "group.call.media-mode",
      groupId: crypto.randomUUID(),
      callId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      deviceId: crypto.randomUUID(),
      sessionId: "session-1",
      mode: "required",
      changedAt: new Date().toISOString(),
    });
    expect(groupCallMediaMode.success).toBe(true);

    const participantJoined = wsServer({
      type: "group.call.participant_joined",
      groupId: crypto.randomUUID(),
      callId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      deviceId: crypto.randomUUID(),
      sessionId: "session-1",
      joinedAt: new Date().toISOString(),
    });
    expect(participantJoined.success).toBe(true);

    const participantLeft = wsServer({
      type: "group.call.participant_left",
      groupId: crypto.randomUUID(),
      callId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      deviceId: crypto.randomUUID(),
      sessionId: "session-1",
      leftAt: new Date().toISOString(),
    });
    expect(participantLeft.success).toBe(true);

    const participantDeviceJoined = wsServer({
      type: "group.call.participant_device_joined",
      groupId: crypto.randomUUID(),
      callId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      deviceId: crypto.randomUUID(),
      sessionId: "session-1",
      joinedAt: new Date().toISOString(),
    });
    expect(participantDeviceJoined.success).toBe(true);

    const participantDeviceLeft = wsServer({
      type: "group.call.participant_device_left",
      groupId: crypto.randomUUID(),
      callId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      deviceId: crypto.randomUUID(),
      sessionId: "session-1",
      leftAt: new Date().toISOString(),
    });
    expect(participantDeviceLeft.success).toBe(true);

    const groupCallEnded = wsServer({
      type: "group.call.ended",
      groupId: crypto.randomUUID(),
      callId: crypto.randomUUID(),
      endedByUserId: crypto.randomUUID(),
      endedAt: new Date().toISOString(),
    });
    expect(groupCallEnded.success).toBe(true);

    const mediaKey = wsServer({
      type: "group.call.media-key",
      callId: crypto.randomUUID(),
      senderUserId: crypto.randomUUID(),
      senderDeviceId: crypto.randomUUID(),
      targetDeviceId: crypto.randomUUID(),
      epoch: 2,
      keyId: "sender-key-2",
      algorithm: "aes-256-gcm",
      encryptedKey: "v1.ciphertext",
      sentAt: new Date().toISOString(),
    });
    expect(mediaKey.success).toBe(true);

    const mediaKeyAck = wsServer({
      type: "group.call.media-key.ack",
      callId: crypto.randomUUID(),
      senderUserId: crypto.randomUUID(),
      senderDeviceId: crypto.randomUUID(),
      targetDeviceId: crypto.randomUUID(),
      epoch: 2,
      keyId: "sender-key-2",
      ackedAt: new Date().toISOString(),
    });
    expect(mediaKeyAck.success).toBe(true);

    const producerState = wsServer({
      type: "group.call.producer_state",
      groupId: crypto.randomUUID(),
      callId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      deviceId: crypto.randomUUID(),
      sessionId: "session-1",
      producerId: "producer-1",
      kind: "video",
      source: "screen",
      state: "removed",
      changedAt: new Date().toISOString(),
    });
    expect(producerState.success).toBe(true);

    const missingActivity = wsClient({
      type: "call.media_state",
      callId: crypto.randomUUID(),
      source: "camera",
      state: "on",
      seq: 1,
    });
    expect(missingActivity.success).toBe(false);

    const callAuthError = wsServer({
      type: "error",
      code: "INVALID_CALL_AUTH",
      message: "Call auth proof already used",
      reason: "replayed_call_auth",
    });
    expect(callAuthError.success).toBe(true);
  });

  it("rejects unsupported websocket versions and unexpected extra fields", () => {
    expect(
      WsClientMessageSchema.safeParse({
        version: WS_PROTOCOL_VERSION + 1,
        type: "ping",
        id: "ping-1",
      }).success
    ).toBe(false);

    expect(
      wsServer({
        type: "pong",
        id: "ping-1",
        unexpectedField: true,
      }).success
    ).toBe(false);
  });

  it("bounds free-form SDP, ICE candidate, and rtpCapabilities strings", () => {
    const oversized = "x".repeat(128 * 1024 + 1);
    expect(
      wsClient({
        type: "call.offer",
        callId: crypto.randomUUID(),
        targetUserId: crypto.randomUUID(),
        sdp: oversized,
        callType: "audio",
      }).success
    ).toBe(false);

    expect(
      wsClient({
        type: "call.ice",
        callId: crypto.randomUUID(),
        candidate: "x".repeat(4 * 1024 + 1),
      }).success
    ).toBe(false);

    expect(
      wsClient({
        type: "call.ice.batch",
        callId: crypto.randomUUID(),
        candidates: ["x".repeat(4 * 1024 + 1)],
      }).success
    ).toBe(false);

    expect(
      wsClient({
        type: "room.join",
        roomId: crypto.randomUUID(),
        rtpCapabilities: "x".repeat(256 * 1024 + 1),
      }).success
    ).toBe(false);
  });
});
