import { z } from "zod";
import { EncryptedMessageSchema, MessageTypeSchema } from "./messages.js";
import { PlainMessageSchema } from "./plain.js";
import {
  type StripVersion,
  type VersionedWireParseResult,
  WS_PROTOCOL_VERSION,
  safeParseVersionedWire,
  versionedWireObject,
  withWireVersion,
} from "./common.js";

export { WS_PROTOCOL_VERSION } from "./common.js";
import {
  CallMediaActivitySchema,
  CallMediaEncryptionAnswerSchema,
  CallMediaEncryptionOfferSchema,
  CallMediaSourceSchema,
  CallMediaStateReasonSchema,
  CallMediaStateSchema,
  DirectCallFeaturesSchema,
  GroupCallMediaEncryptionModeSchema,
  GroupCallMediaKeyAckBodySchema,
  GroupCallMediaKeySignalBodySchema,
} from "./media-encryption.js";
import { SfuProducerSourceSchema } from "./sfu.js";

export const WS_CLIENT_PROTOCOL = `seclettr.v${WS_PROTOCOL_VERSION}`;
export const WS_AUTH_PROTOCOL_PREFIX = "seclettr.auth.";

/**
 * Bounds for inherently large free-form strings. SDP offers/answers with many
 * codecs are a few KiB; ICE candidates and rtpCapabilities JSON are small.
 * Without an upper bound a peer could force large allocations on the API and
 * every relayed client (AUDIT.md H15).
 */
const MAX_SDP_LENGTH = 128 * 1024;
const MAX_ICE_CANDIDATE_LENGTH = 4 * 1024;
const MAX_RTP_CAPABILITIES_LENGTH = 256 * 1024;

const CallSignalAuthSchema = versionedWireObject(1, {
  senderUserId: z.string().uuid(),
  senderDeviceId: z.string().uuid(),
  recipientUserId: z.string().uuid(),
  signedAt: z.string().datetime(),
  sdpHash: z.string().min(43).max(44),
  signature: z.string().min(1),
});

const wsEnvelope = <TShape extends z.ZodRawShape>(shape: TShape) =>
  versionedWireObject(WS_PROTOCOL_VERSION, shape);

const DirectChatKindSchema = z.enum(["e2ee", "plain"]);

export const WsClientMessageSchema = z.discriminatedUnion("type", [
  wsEnvelope({
    type: z.literal("ping"),
    id: z.string(),
  }),
  wsEnvelope({
    type: z.literal("ack"),
    messageId: z.string().uuid(),
  }),
  wsEnvelope({
    type: z.literal("message.read"),
    messageId: z.string().uuid(),
  }),
  wsEnvelope({
    type: z.literal("typing.start"),
    targetUserId: z.string().uuid(),
    chatKind: DirectChatKindSchema.optional(),
  }),
  wsEnvelope({
    type: z.literal("typing.stop"),
    targetUserId: z.string().uuid(),
    chatKind: DirectChatKindSchema.optional(),
  }),
  wsEnvelope({
    type: z.literal("call.offer"),
    callId: z.string().uuid(),
    targetUserId: z.string().uuid(),
    sdp: z.string().max(MAX_SDP_LENGTH),
    callType: z.enum(["audio", "video"]),
    chatKind: DirectChatKindSchema.optional(),
    mediaEncryption: CallMediaEncryptionOfferSchema.optional(),
    features: DirectCallFeaturesSchema.optional(),
    auth: CallSignalAuthSchema.optional(),
  }),
  wsEnvelope({
    type: z.literal("call.answer"),
    callId: z.string().uuid(),
    sdp: z.string().max(MAX_SDP_LENGTH),
    mediaEncryption: CallMediaEncryptionAnswerSchema.optional(),
    features: DirectCallFeaturesSchema.optional(),
    auth: CallSignalAuthSchema.optional(),
  }),
  wsEnvelope({
    type: z.literal("call.renegotiate.offer"),
    callId: z.string().uuid(),
    revision: z.number().int().positive(),
    sdp: z.string().max(MAX_SDP_LENGTH),
    auth: CallSignalAuthSchema.optional(),
  }),
  wsEnvelope({
    type: z.literal("call.renegotiate.answer"),
    callId: z.string().uuid(),
    revision: z.number().int().positive(),
    sdp: z.string().max(MAX_SDP_LENGTH),
    auth: CallSignalAuthSchema.optional(),
  }),
  wsEnvelope({
    type: z.literal("call.ice"),
    callId: z.string().uuid(),
    candidate: z.string().max(MAX_ICE_CANDIDATE_LENGTH),
  }),
  wsEnvelope({
    type: z.literal("call.ice.batch"),
    callId: z.string().uuid(),
    candidates: z.array(z.string().max(MAX_ICE_CANDIDATE_LENGTH)).min(1).max(32),
  }),
  wsEnvelope({
    type: z.literal("call.hangup"),
    callId: z.string().uuid(),
  }),
  wsEnvelope({
    type: z.literal("call.media_state"),
    callId: z.string().uuid(),
    source: CallMediaSourceSchema,
    state: CallMediaStateSchema,
    activity: CallMediaActivitySchema,
    mid: z.string().min(1).max(64).nullable().optional(),
    seq: z.number().int().positive(),
    streamRevision: z.number().int().positive().optional(),
    reason: CallMediaStateReasonSchema.optional(),
  }),
  wsEnvelope({
    type: z.literal("call.reject"),
    callId: z.string().uuid(),
  }),
  GroupCallMediaKeySignalBodySchema.extend({
    version: z.literal(WS_PROTOCOL_VERSION),
    type: z.literal("group.call.media-key"),
    callId: z.string().uuid(),
  }).strict(),
  GroupCallMediaKeyAckBodySchema.extend({
    version: z.literal(WS_PROTOCOL_VERSION),
    type: z.literal("group.call.media-key.ack"),
    callId: z.string().uuid(),
  }).strict(),
  wsEnvelope({
    type: z.literal("group.call.media-mode"),
    callId: z.string().uuid(),
    mode: GroupCallMediaEncryptionModeSchema,
  }),
  wsEnvelope({
    type: z.literal("group.call.producer_state"),
    callId: z.string().uuid(),
    producerId: z.string().min(1).max(256),
    kind: z.enum(["audio", "video"]),
    source: SfuProducerSourceSchema.optional(),
    state: z.enum(["added", "removed"]),
  }),
  wsEnvelope({
    type: z.literal("room.join"),
    roomId: z.string().uuid(),
    rtpCapabilities: z.string().max(MAX_RTP_CAPABILITIES_LENGTH),
  }),
  wsEnvelope({
    type: z.literal("room.leave"),
    roomId: z.string().uuid(),
  }),
]);
export type WsClientWireMessage = z.infer<typeof WsClientMessageSchema>;
export type WsClientMessage = StripVersion<WsClientWireMessage>;

export function toWsClientWireMessage(
  message: WsClientMessage | WsClientWireMessage
): WsClientWireMessage {
  return withWireVersion(message, WS_PROTOCOL_VERSION) as WsClientWireMessage;
}

export function safeParseWsClientMessage(
  payload: unknown
): VersionedWireParseResult<WsClientWireMessage> {
  return safeParseVersionedWire(
    WsClientMessageSchema,
    payload,
    WS_PROTOCOL_VERSION
  );
}

export const WsServerMessageSchema = z.discriminatedUnion("type", [
  wsEnvelope({
    type: z.literal("pong"),
    id: z.string(),
  }),
  wsEnvelope({
    type: z.literal("message.new"),
    message: EncryptedMessageSchema,
  }),
  wsEnvelope({
    type: z.literal("group_message.new"),
    groupId: z.string().uuid(),
    senderDeviceId: z.string().uuid(),
    distributionId: z.string().uuid(),
    cryptoEpoch: z.number().int().min(1).max(1_000_000),
    chainId: z.number().int(),
    messageId: z.number().int(),
    ciphertext: z.string(),
    signature: z.string(),
    messageType: MessageTypeSchema,
    createdAt: z.string().datetime(),
    aeadVersion: z.number().int().min(0).max(1).optional(),
  }),
  wsEnvelope({
    type: z.literal("plain_message.new"),
    message: PlainMessageSchema,
  }),
  wsEnvelope({
    type: z.literal("plain_message.edited"),
    messageId: z.string().uuid(),
    content: z.string(),
    editedAt: z.string().datetime(),
    /** Conversation key: recipientUserId (DM) or groupId (group) */
    threadKey: z.string().uuid(),
    threadKind: z.enum(["dm", "group"]),
  }),
  wsEnvelope({
    type: z.literal("plain_message.deleted"),
    messageId: z.string().uuid(),
    threadKey: z.string().uuid(),
    threadKind: z.enum(["dm", "group"]),
  }),
  wsEnvelope({
    type: z.literal("plain_message.read"),
    messageIds: z.array(z.string().uuid()),
    readerUserId: z.string().uuid(),
    threadKey: z.string().uuid(),
    threadKind: z.enum(["dm", "group"]),
    readAt: z.string().datetime(),
  }),
  wsEnvelope({
    type: z.literal("call.incoming"),
    callId: z.string().uuid(),
    callerUserId: z.string().uuid(),
    callerDeviceId: z.string().uuid(),
    callType: z.enum(["audio", "video"]),
  }),
  wsEnvelope({
    type: z.literal("call.answered"),
    callId: z.string().uuid(),
    answererUserId: z.string().uuid().optional(),
    answererDeviceId: z.string().uuid().optional(),
    targetUserId: z.string().uuid().optional(),
    sdp: z.string().max(MAX_SDP_LENGTH),
    mediaEncryption: CallMediaEncryptionAnswerSchema.optional(),
    features: DirectCallFeaturesSchema.optional(),
    auth: CallSignalAuthSchema.optional(),
  }),
  wsEnvelope({
    type: z.literal("call.offer"),
    callId: z.string().uuid(),
    callerUserId: z.string().uuid(),
    callerDeviceId: z.string().uuid().optional(),
    targetUserId: z.string().uuid().optional(),
    sdp: z.string().max(MAX_SDP_LENGTH),
    callType: z.enum(["audio", "video"]),
    chatKind: DirectChatKindSchema.optional(),
    mediaEncryption: CallMediaEncryptionOfferSchema.optional(),
    features: DirectCallFeaturesSchema.optional(),
    auth: CallSignalAuthSchema.optional(),
  }),
  wsEnvelope({
    type: z.literal("call.renegotiate.offer"),
    callId: z.string().uuid(),
    revision: z.number().int().positive(),
    senderUserId: z.string().uuid(),
    senderDeviceId: z.string().uuid(),
    sdp: z.string().max(MAX_SDP_LENGTH),
    auth: CallSignalAuthSchema.optional(),
  }),
  wsEnvelope({
    type: z.literal("call.renegotiate.answer"),
    callId: z.string().uuid(),
    revision: z.number().int().positive(),
    senderUserId: z.string().uuid(),
    senderDeviceId: z.string().uuid(),
    sdp: z.string().max(MAX_SDP_LENGTH),
    auth: CallSignalAuthSchema.optional(),
  }),
  wsEnvelope({
    type: z.literal("call.ice"),
    callId: z.string().uuid(),
    candidate: z.string().max(MAX_ICE_CANDIDATE_LENGTH),
  }),
  wsEnvelope({
    type: z.literal("call.ice.batch"),
    callId: z.string().uuid(),
    candidates: z.array(z.string().max(MAX_ICE_CANDIDATE_LENGTH)).min(1).max(32),
  }),
  wsEnvelope({
    type: z.literal("call.hangup"),
    callId: z.string().uuid(),
  }),
  wsEnvelope({
    type: z.literal("call.media_state"),
    callId: z.string().uuid(),
    senderUserId: z.string().uuid(),
    senderDeviceId: z.string().uuid(),
    source: CallMediaSourceSchema,
    state: CallMediaStateSchema,
    activity: CallMediaActivitySchema,
    mid: z.string().min(1).max(64).nullable().optional(),
    seq: z.number().int().positive(),
    streamRevision: z.number().int().positive().optional(),
    reason: CallMediaStateReasonSchema.optional(),
    changedAt: z.string().datetime(),
  }),
  wsEnvelope({
    type: z.literal("call.rejected"),
    callId: z.string().uuid(),
  }),
  GroupCallMediaKeySignalBodySchema.extend({
    version: z.literal(WS_PROTOCOL_VERSION),
    type: z.literal("group.call.media-key"),
    callId: z.string().uuid(),
    senderUserId: z.string().uuid(),
    senderDeviceId: z.string().uuid(),
    sentAt: z.string().datetime(),
  }).strict(),
  GroupCallMediaKeyAckBodySchema.extend({
    version: z.literal(WS_PROTOCOL_VERSION),
    type: z.literal("group.call.media-key.ack"),
    callId: z.string().uuid(),
    senderUserId: z.string().uuid(),
    senderDeviceId: z.string().uuid(),
    ackedAt: z.string().datetime(),
  }).strict(),
  wsEnvelope({
    type: z.literal("group.call.media-mode"),
    groupId: z.string().uuid(),
    callId: z.string().uuid(),
    userId: z.string().uuid(),
    deviceId: z.string().uuid(),
    sessionId: z.string().optional(),
    mode: GroupCallMediaEncryptionModeSchema,
    changedAt: z.string().datetime(),
  }),
  wsEnvelope({
    type: z.literal("group.call.producer_state"),
    groupId: z.string().uuid(),
    callId: z.string().uuid(),
    userId: z.string().uuid(),
    deviceId: z.string().uuid(),
    sessionId: z.string().optional(),
    producerId: z.string().min(1).max(256),
    kind: z.enum(["audio", "video"]),
    source: SfuProducerSourceSchema.optional(),
    state: z.enum(["added", "removed"]),
    changedAt: z.string().datetime(),
  }),
  wsEnvelope({
    type: z.literal("group.call.started"),
    groupId: z.string().uuid(),
    callId: z.string().uuid(),
    callType: z.enum(["audio", "video"]),
    callerUserId: z.string().uuid(),
    startedAt: z.string().datetime(),
  }),
  wsEnvelope({
    type: z.literal("group.call.ended"),
    groupId: z.string().uuid(),
    callId: z.string().uuid(),
    callerUserId: z.string().uuid().optional(),
    endedByUserId: z.string().uuid(),
    endedAt: z.string().datetime(),
    /** True when the call ended before any other member joined (missed). */
    wasMissed: z.boolean().optional(),
  }),
  wsEnvelope({
    type: z.literal("group.call.participant_joined"),
    groupId: z.string().uuid(),
    callId: z.string().uuid(),
    userId: z.string().uuid(),
    deviceId: z.string().uuid().optional(),
    sessionId: z.string().optional(),
    joinedAt: z.string().datetime(),
  }),
  wsEnvelope({
    type: z.literal("group.call.participant_left"),
    groupId: z.string().uuid(),
    callId: z.string().uuid(),
    userId: z.string().uuid(),
    deviceId: z.string().uuid().optional(),
    sessionId: z.string().optional(),
    leftAt: z.string().datetime(),
  }),
  wsEnvelope({
    type: z.literal("group.call.participant_device_joined"),
    groupId: z.string().uuid(),
    callId: z.string().uuid(),
    userId: z.string().uuid(),
    deviceId: z.string().uuid(),
    sessionId: z.string().optional(),
    joinedAt: z.string().datetime(),
  }),
  wsEnvelope({
    type: z.literal("group.call.participant_device_left"),
    groupId: z.string().uuid(),
    callId: z.string().uuid(),
    userId: z.string().uuid(),
    deviceId: z.string().uuid(),
    sessionId: z.string().optional(),
    leftAt: z.string().datetime(),
  }),
  wsEnvelope({
    type: z.literal("group.member_added"),
    groupId: z.string().uuid(),
    addedByUserId: z.string().uuid(),
    addedAt: z.string().datetime(),
    cryptoEpoch: z.number().int().min(1).max(1_000_000).optional(),
  }),
  wsEnvelope({
    type: z.literal("group.member_removed"),
    groupId: z.string().uuid(),
    removedUserId: z.string().uuid(),
    removedByUserId: z.string().uuid(),
    removedAt: z.string().datetime(),
    cryptoEpoch: z.number().int().min(1).max(1_000_000),
  }),
  wsEnvelope({
    type: z.literal("message.delivered"),
    messageId: z.string().uuid(),
    clientMessageId: z.string().uuid().optional(),
  }),
  wsEnvelope({
    type: z.literal("message.read"),
    messageId: z.string().uuid(),
    clientMessageId: z.string().uuid().optional(),
    readerUserId: z.string().uuid(),
    readerDeviceId: z.string().uuid(),
    readAt: z.string().datetime(),
  }),
  wsEnvelope({
    type: z.literal("typing.start"),
    senderUserId: z.string().uuid(),
    senderDeviceId: z.string().uuid(),
    chatKind: DirectChatKindSchema.optional(),
  }),
  wsEnvelope({
    type: z.literal("typing.stop"),
    senderUserId: z.string().uuid(),
    senderDeviceId: z.string().uuid(),
    chatKind: DirectChatKindSchema.optional(),
  }),
  wsEnvelope({
    type: z.literal("presence.update"),
    userId: z.string().uuid(),
    online: z.boolean(),
    lastSeenAt: z.string().datetime().optional(),
  }),
  wsEnvelope({
    type: z.literal("prekeys.low"),
    remaining: z.number().int(),
  }),
  wsEnvelope({
    type: z.literal("error"),
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(1024),
    reason: z.string().min(1).max(128).optional(),
  }),
]);
export type WsServerWireMessage = z.infer<typeof WsServerMessageSchema>;
export type WsServerMessage = StripVersion<WsServerWireMessage>;

export function toWsServerWireMessage(
  message: WsServerMessage | WsServerWireMessage
): WsServerWireMessage {
  return withWireVersion(message, WS_PROTOCOL_VERSION) as WsServerWireMessage;
}

export function safeParseWsServerMessage(
  payload: unknown
): VersionedWireParseResult<WsServerWireMessage> {
  return safeParseVersionedWire(
    WsServerMessageSchema,
    payload,
    WS_PROTOCOL_VERSION
  );
}
