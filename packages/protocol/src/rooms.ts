import { z } from "zod";
import { type StripVersion, versionedWireObject } from "./common.js";

export const ROOMS_PROTOCOL_VERSION = 1 as const;

export const RoomCreateResponseSchema = versionedWireObject(ROOMS_PROTOCOL_VERSION, {
  callId: z.string().uuid(),
  inviteToken: z.string(),
  inviteUrl: z.string(),
  expiresAt: z.string().datetime(),
});

export const RoomJoinPreviewResponseSchema = versionedWireObject(ROOMS_PROTOCOL_VERSION, {
  callId: z.string().uuid(),
  callType: z.enum(["audio", "video"]),
  hostUsername: z.string(),
  expiresAt: z.string().datetime(),
  participantCount: z.number().int().nonnegative(),
});

export const RoomJoinResponseSchema = versionedWireObject(ROOMS_PROTOCOL_VERSION, {
  callId: z.string().uuid(),
  callType: z.enum(["audio", "video"]),
  guestToken: z.string(),
  guestSessionId: z.string().uuid(),
  /** Public SFU URL for the guest browser. Omitted when the client should
   *  use its own runtime-resolved SFU endpoint (e.g. same-origin /sfu). */
  sfuUrl: z.string().optional(),
  expiresAt: z.string().datetime(),
});

export const RoomParticipantsResponseSchema = versionedWireObject(ROOMS_PROTOCOL_VERSION, {
  participants: z.array(z.object({
    id: z.string().uuid(),
    displayName: z.string(),
    isGuest: z.boolean(),
  })),
});

export type RoomCreateResponseWire = z.infer<typeof RoomCreateResponseSchema>;
export type RoomCreateResponse = StripVersion<RoomCreateResponseWire>;

export type RoomJoinPreviewResponseWire = z.infer<typeof RoomJoinPreviewResponseSchema>;
export type RoomJoinPreviewResponse = StripVersion<RoomJoinPreviewResponseWire>;

export type RoomJoinResponseWire = z.infer<typeof RoomJoinResponseSchema>;
export type RoomJoinResponse = StripVersion<RoomJoinResponseWire>;

export type RoomParticipantsResponseWire = z.infer<typeof RoomParticipantsResponseSchema>;
export type RoomParticipantsResponse = StripVersion<RoomParticipantsResponseWire>;
