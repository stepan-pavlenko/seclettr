import type { FastifyInstance } from "fastify";
import type { WsClientMessage, WsServerMessage } from "@seclettr/protocol";
import { query } from "../db/pool.js";
import {
  removeGroupCallParticipant,
  listGroupCallParticipantDevices,
  listGroupCallParticipants,
} from "./group-call-presence.js";
import {
  buildParticipantLifecycleEvents,
  endGroupCallIfRosterEmpty,
  loadGroupMemberDeviceIds,
  hasActiveGroupMembership,
  publishGroupCallFanOutExcludingSender,
  type ActiveCallSession,
} from "./group-call-participant-routing.js";
import { publishMessage } from "./redis.js";
import type { ConnectedClient } from "./ws-runtime.js";
import { send } from "./ws-runtime.js";

/* ── Types ───────────────────────────────────────────────────────────────── */

type ActiveRoomSession = {
  id: string;
  group_id: string | null;
};

type GroupProducerLifecycleEvent = Extract<
  WsServerMessage,
  { type: "group.call.producer_state" }
>;
type GroupMediaModeEvent = Extract<
  WsServerMessage,
  { type: "group.call.media-mode" }
>;

/* ── Deps interface (injectable for tests) ────────────────────────────────── */

export interface RoomLifecycleDeps {
  query: typeof query;
  removeGroupCallParticipant: typeof removeGroupCallParticipant;
  listGroupCallParticipantDevices: typeof listGroupCallParticipantDevices;
  listGroupCallParticipants: typeof listGroupCallParticipants;
  publishMessage: typeof publishMessage;
  loadGroupMemberDeviceIds: typeof loadGroupMemberDeviceIds;
  hasActiveGroupMembership: typeof hasActiveGroupMembership;
  buildParticipantLifecycleEvents: typeof buildParticipantLifecycleEvents;
  endGroupCallIfRosterEmpty: typeof endGroupCallIfRosterEmpty;
  publishGroupCallFanOutExcludingSender: typeof publishGroupCallFanOutExcludingSender;
  send: typeof send;
}

/* ── Interface ────────────────────────────────────────────────────────────── */

export interface RoomLifecycleManager {
  handleRoomSignal(
    fastify: FastifyInstance,
    sender: ConnectedClient,
    msg: Extract<WsClientMessage, { type: "room.join" | "room.leave" }>
  ): Promise<void>;
  cleanupJoinedRoomsOnDisconnect(
    fastify: FastifyInstance,
    client: ConnectedClient
  ): Promise<void>;
  leaveJoinedRoom(
    sender: ConnectedClient,
    roomId: string
  ): Promise<void>;
  detachJoinedRoomTransport(
    sender: ConnectedClient,
    roomId: string
  ): void;
  getActiveRoomSession(
    roomId: string
  ): Promise<ActiveRoomSession | null>;
  publishGroupCallEventExcludingSender(
    callId: string,
    groupId: string,
    senderDeviceId: string,
    payload: Record<string, unknown>
  ): Promise<void>;
  publishGroupProducerStateEvent(
    callId: string,
    groupId: string,
    senderDeviceId: string,
    payload: GroupProducerLifecycleEvent
  ): Promise<void>;
  publishGroupMediaModeEvent(
    callId: string,
    groupId: string,
    senderDeviceId: string,
    payload: GroupMediaModeEvent
  ): Promise<void>;
}

/* ── Factory ──────────────────────────────────────────────────────────────── */

export function createRoomLifecycleManager(
  deps?: Partial<RoomLifecycleDeps>
): RoomLifecycleManager {
  const {
    query: queryFn = query,
    removeGroupCallParticipant: removeGroupCallParticipantFn = removeGroupCallParticipant,
    listGroupCallParticipantDevices: listGroupCallParticipantDevicesFn = listGroupCallParticipantDevices,
    listGroupCallParticipants: listGroupCallParticipantsFn = listGroupCallParticipants,
    publishMessage: publishMessageFn = publishMessage,
    loadGroupMemberDeviceIds: loadGroupMemberDeviceIdsFn = loadGroupMemberDeviceIds,
    hasActiveGroupMembership: hasActiveGroupMembershipFn = hasActiveGroupMembership,
    buildParticipantLifecycleEvents: buildParticipantLifecycleEventsFn = buildParticipantLifecycleEvents,
    endGroupCallIfRosterEmpty: endGroupCallIfRosterEmptyFn = endGroupCallIfRosterEmpty,
    publishGroupCallFanOutExcludingSender: publishGroupCallFanOutExcludingSenderFn = publishGroupCallFanOutExcludingSender,
    send: sendFn = send,
  } = deps ?? {};

  async function getActiveRoomSession(
    roomId: string
  ): Promise<ActiveRoomSession | null> {
    const sessions = await queryFn<ActiveRoomSession>(
      `SELECT id, group_id
       FROM call_sessions
       WHERE id = $1
         AND status IN ('ringing', 'active')`,
      [roomId]
    );
    return sessions[0] ?? null;
  }

  async function publishGroupCallEventExcludingSender(
    callId: string,
    groupId: string,
    senderDeviceId: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    return publishGroupCallFanOutExcludingSenderFn(
      callId,
      groupId,
      senderDeviceId,
      listGroupCallParticipantDevicesFn,
      listGroupCallParticipantsFn,
      payload
    );
  }

  async function publishGroupProducerStateEvent(
    callId: string,
    groupId: string,
    senderDeviceId: string,
    payload: GroupProducerLifecycleEvent
  ): Promise<void> {
    await publishGroupCallEventExcludingSender(callId, groupId, senderDeviceId, payload);
  }

  async function publishGroupMediaModeEvent(
    callId: string,
    groupId: string,
    senderDeviceId: string,
    payload: GroupMediaModeEvent
  ): Promise<void> {
    await publishGroupCallEventExcludingSender(callId, groupId, senderDeviceId, payload);
  }

  async function leaveJoinedRoom(
    sender: ConnectedClient,
    roomId: string
  ): Promise<void> {
    const room = await getActiveRoomSession(roomId);
    if (!room?.group_id) return;

    const removed = await removeGroupCallParticipantFn(
      room.id,
      sender.userId,
      sender.deviceId
    );
    if (!removed.deviceRemoved) return;

    const events = buildParticipantLifecycleEventsFn("left", {
      groupId: room.group_id,
      callId: room.id,
      userId: sender.userId,
      deviceId: sender.deviceId,
      sessionId: sender.sessionId,
      timestamp: new Date().toISOString(),
      includeUserEvent: removed.userRemoved,
    });
    const deviceIds = await loadGroupMemberDeviceIdsFn(room.group_id);
    await Promise.all(
      events.map((event) =>
        Promise.all(
          deviceIds.map((deviceId) =>
            publishMessageFn({
              ...event,
              recipientDeviceId: deviceId,
            })
          )
        )
      )
    );

    const callSession: ActiveCallSession = {
      id: room.id,
      caller_user_id: "",
      callee_user_id: null,
      group_id: room.group_id,
      call_type: "audio",
      status: "active",
      is_room: false,
    };
    await endGroupCallIfRosterEmptyFn(callSession, sender.userId);
  }

  function detachJoinedRoomTransport(
    sender: ConnectedClient,
    roomId: string
  ): void {
    sender.joinedRoomIds.delete(roomId);
  }

  async function cleanupJoinedRoomsOnDisconnect(
    fastify: FastifyInstance,
    client: ConnectedClient
  ): Promise<void> {
    const roomIds = [...client.joinedRoomIds];
    client.joinedRoomIds.clear();

    for (const roomId of roomIds) {
      try {
        await leaveJoinedRoom(client, roomId);
      } catch (err) {
        fastify.log.debug(
          { err, roomId, userId: client.userId },
          "Failed to cleanup joined room on disconnect"
        );
      }
    }
  }

  async function handleRoomSignal(
    fastify: FastifyInstance,
    sender: ConnectedClient,
    msg: Extract<WsClientMessage, { type: "room.join" | "room.leave" }>
  ): Promise<void> {
    if (msg.type === "room.leave") {
      detachJoinedRoomTransport(sender, msg.roomId);
      fastify.log.debug(
        { roomId: msg.roomId, userId: sender.userId, deviceId: sender.deviceId },
        "WS room.leave detached live transport without mutating roster"
      );
      return;
    }

    const room = await getActiveRoomSession(msg.roomId);
    if (!room) {
      sendFn(sender.ws, {
        type: "error",
        code: "ROOM_NOT_FOUND",
        message: "Room not found",
      });
      return;
    }

    sender.joinedRoomIds.add(room.id);

    if (!room.group_id) {
      return;
    }

    if (!(await hasActiveGroupMembershipFn(room.group_id, sender.userId))) {
      sender.joinedRoomIds.delete(room.id);
      sendFn(sender.ws, {
        type: "error",
        code: "FORBIDDEN",
        message: "Forbidden",
      });
      return;
    }
    fastify.log.debug(
      { roomId: room.id, userId: sender.userId, deviceId: sender.deviceId },
      "WS room.join attached live transport without mutating roster"
    );
  }

  return {
    handleRoomSignal,
    cleanupJoinedRoomsOnDisconnect,
    leaveJoinedRoom,
    detachJoinedRoomTransport,
    getActiveRoomSession,
    publishGroupCallEventExcludingSender,
    publishGroupProducerStateEvent,
    publishGroupMediaModeEvent,
  };
}
