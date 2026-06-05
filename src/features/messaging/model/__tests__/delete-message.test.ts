import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { ChatDatabase } from "@/shared/lib/local-db/schema";
import type { LocalMessage, LocalRoom } from "@/shared/lib/local-db/schema";
import { MessageRepository } from "@/shared/lib/local-db/message-repository";
import { RoomRepository } from "@/shared/lib/local-db/room-repository";
import { UserRepository } from "@/shared/lib/local-db/user-repository";
import { EventWriter } from "@/shared/lib/local-db/event-writer";
import { MessageType } from "@/entities/chat/model/types";
import { isServerEventId } from "../redact-target";

/**
 * WEE-66 / forta-bugs#773, #864 — "delete for all" must work for pending
 * messages that only have a clientId (no server $eventId yet).
 *
 * Root cause (H1): deleteMessage redacted by `message.id` = eventId ?? clientId.
 * For a not-yet-confirmed message that is the clientId, which the server has
 * never seen — softDelete (eventId-only) found nothing and SyncEngine queued a
 * redact for a clientId that silently failed server-side.
 */

let db: ChatDatabase;
let msgRepo: MessageRepository;
let roomRepo: RoomRepository;
let userRepo: UserRepository;
let eventWriter: EventWriter;

const ROOM_ID = "!room:server";

function makeMsg(overrides: Partial<LocalMessage> = {}): LocalMessage {
  return {
    eventId: overrides.eventId ?? `$evt_${Math.random().toString(36).slice(2)}`,
    clientId: overrides.clientId ?? `cli_${Math.random().toString(36).slice(2)}`,
    roomId: overrides.roomId ?? ROOM_ID,
    senderId: overrides.senderId ?? "user1",
    content: overrides.content ?? "hello",
    timestamp: overrides.timestamp ?? Date.now(),
    type: overrides.type ?? MessageType.text,
    status: overrides.status ?? "synced",
    version: 1,
    softDeleted: false,
    ...overrides,
  } as LocalMessage;
}

function makeRoom(overrides: Partial<LocalRoom> = {}): LocalRoom {
  return {
    id: overrides.id ?? ROOM_ID,
    name: "Test Room",
    isGroup: false,
    members: ["user1", "user2"],
    membership: "join",
    unreadCount: 0,
    lastReadInboundTs: 0,
    lastReadOutboundTs: 0,
    updatedAt: Date.now(),
    syncedAt: Date.now(),
    hasMoreHistory: true,
    isDeleted: false,
    deletedAt: null,
    deleteReason: null,
    ...overrides,
  };
}

beforeEach(async () => {
  const name = `test-delete-message-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db = new ChatDatabase(name);
  await db.open();
  msgRepo = new MessageRepository(db);
  roomRepo = new RoomRepository(db);
  userRepo = new UserRepository(db);
  eventWriter = new EventWriter(db, msgRepo, roomRepo, userRepo);
});

afterEach(async () => {
  await db.delete();
});

describe("isServerEventId — only $-prefixed ids are known to the server", () => {
  it("returns true for a Matrix event id", () => {
    expect(isServerEventId("$abc:server")).toBe(true);
  });

  it("returns false for a local clientId (UUID, pending message)", () => {
    expect(isServerEventId("3f9a1c2e-1111-2222-3333-444455556666")).toBe(false);
    expect(isServerEventId("cli_xyz")).toBe(false);
  });

  it("returns false for empty / non-string input", () => {
    expect(isServerEventId("")).toBe(false);
    // @ts-expect-error — runtime guard against bad callers
    expect(isServerEventId(undefined)).toBe(false);
  });
});

describe("MessageRepository.softDelete — matches eventId OR clientId", () => {
  it("soft-deletes a synced message by its eventId (regression)", async () => {
    await db.messages.add(makeMsg({ eventId: "$msg1", clientId: "cli1" }));

    await msgRepo.softDelete("$msg1");

    const row = await db.messages.where("clientId").equals("cli1").first();
    expect(row!.softDeleted).toBe(true);
    expect(row!.deletedAt).toBeGreaterThan(0);
  });

  it("soft-deletes a pending message by its clientId when eventId is null", async () => {
    await db.messages.add(
      makeMsg({ eventId: null, clientId: "pending-1", status: "pending" }),
    );

    // deleteMessage passes message.id = eventId ?? clientId = "pending-1"
    await msgRepo.softDelete("pending-1");

    const row = await db.messages.where("clientId").equals("pending-1").first();
    expect(row!.softDeleted).toBe(true);
  });
});

describe("EventWriter.writeRedaction — pending message (clientId) deletes locally", () => {
  it("soft-deletes a pending message identified only by clientId", async () => {
    await db.rooms.add(makeRoom());
    await db.messages.add(
      makeMsg({ eventId: null, clientId: "pending-2", status: "pending", content: "draft" }),
    );

    await eventWriter.writeRedaction({ redactedEventId: "pending-2", roomId: ROOM_ID });

    const row = await db.messages.where("clientId").equals("pending-2").first();
    expect(row!.softDeleted).toBe(true);
  });

  it("does NOT queue a server-side redact for a pending (clientId) message", () => {
    // The enqueue guard in use-messages.deleteMessage relies on this predicate:
    // a clientId is not a server identity, so "delete for all" stays local.
    expect(isServerEventId("pending-2")).toBe(false);
  });
});
