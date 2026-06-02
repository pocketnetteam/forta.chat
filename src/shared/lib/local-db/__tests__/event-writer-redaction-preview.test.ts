import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { ChatDatabase } from "../schema";
import type { LocalMessage, LocalRoom } from "../schema";
import { MessageRepository } from "../message-repository";
import { RoomRepository } from "../room-repository";
import { UserRepository } from "../user-repository";
import { EventWriter } from "../event-writer";
import { MessageType } from "@/entities/chat/model/types";

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
  const name = `test-redaction-preview-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

describe("EventWriter.writeRedaction — preview rollback (WEE-43)", () => {
  it("rolls preview back to previous non-redacted message when last message is redacted", async () => {
    // Setup: room where lastMessage is $msg3 (the one we're about to redact).
    const room = makeRoom({
      lastMessageEventId: "$msg3",
      lastMessagePreview: "third",
      lastMessageTimestamp: 3000,
      lastMessageSenderId: "user1",
      lastMessageType: MessageType.text,
    });
    await db.rooms.add(room);

    await db.messages.add(makeMsg({ eventId: "$msg1", content: "first",  timestamp: 1000 }));
    await db.messages.add(makeMsg({ eventId: "$msg2", content: "second", timestamp: 2000 }));
    await db.messages.add(makeMsg({ eventId: "$msg3", content: "third",  timestamp: 3000 }));

    await eventWriter.writeRedaction({ redactedEventId: "$msg3", roomId: ROOM_ID });

    const updatedRoom = await roomRepo.getRoom(ROOM_ID);
    // Critical: monotonic guard must NOT block the rollback to an older message.
    expect(updatedRoom!.lastMessagePreview).toBe("second");
    expect(updatedRoom!.lastMessageEventId).toBe("$msg2");
    expect(updatedRoom!.lastMessageTimestamp).toBe(2000);
  });

  it("shows the deleted sentinel when redacting the only remaining message (Telegram-style, not blank)", async () => {
    const room = makeRoom({
      lastMessageEventId: "$msg1",
      lastMessagePreview: "only",
      lastMessageTimestamp: 1000,
      lastMessageSenderId: "user1",
      lastMessageType: MessageType.text,
    });
    await db.rooms.add(room);

    await db.messages.add(makeMsg({ eventId: "$msg1", content: "only", timestamp: 1000 }));

    await eventWriter.writeRedaction({ redactedEventId: "$msg1", roomId: ROOM_ID });

    const updatedRoom = await roomRepo.getRoom(ROOM_ID);
    // No earlier message to fall back to → show "🚫 Message deleted" (getPreview
    // localises it) instead of blanking the row. The slot is kept so the row
    // doesn't collapse to "no messages".
    expect(updatedRoom!.lastMessagePreview).toBe("🚫 Message deleted");
    expect(updatedRoom!.lastMessageEventId).toBe("$msg1");
    expect(updatedRoom!.lastMessageTimestamp).toBe(1000);
  });

  it("shows the deleted sentinel when redacting the last message among many already-redacted ones", async () => {
    const room = makeRoom({
      lastMessageEventId: "$msg3",
      lastMessagePreview: "third",
      lastMessageTimestamp: 3000,
      lastMessageSenderId: "user1",
      lastMessageType: MessageType.text,
    });
    await db.rooms.add(room);

    await db.messages.add(makeMsg({ eventId: "$msg1", content: "",       timestamp: 1000, softDeleted: true }));
    await db.messages.add(makeMsg({ eventId: "$msg2", content: "",       timestamp: 2000, softDeleted: true }));
    await db.messages.add(makeMsg({ eventId: "$msg3", content: "third",  timestamp: 3000 }));

    await eventWriter.writeRedaction({ redactedEventId: "$msg3", roomId: ROOM_ID });

    const updatedRoom = await roomRepo.getRoom(ROOM_ID);
    expect(updatedRoom!.lastMessagePreview).toBe("🚫 Message deleted");
    expect(updatedRoom!.lastMessageEventId).toBe("$msg3");
  });

  it("does not touch preview when redacting a non-last message", async () => {
    const room = makeRoom({
      lastMessageEventId: "$msg3",
      lastMessagePreview: "third",
      lastMessageTimestamp: 3000,
      lastMessageSenderId: "user1",
      lastMessageType: MessageType.text,
    });
    await db.rooms.add(room);

    await db.messages.add(makeMsg({ eventId: "$msg1", content: "first",  timestamp: 1000 }));
    await db.messages.add(makeMsg({ eventId: "$msg2", content: "second", timestamp: 2000 }));
    await db.messages.add(makeMsg({ eventId: "$msg3", content: "third",  timestamp: 3000 }));

    await eventWriter.writeRedaction({ redactedEventId: "$msg1", roomId: ROOM_ID });

    const updatedRoom = await roomRepo.getRoom(ROOM_ID);
    expect(updatedRoom!.lastMessagePreview).toBe("third");
    expect(updatedRoom!.lastMessageEventId).toBe("$msg3");
    expect(updatedRoom!.lastMessageTimestamp).toBe(3000);
  });

  it("soft-deletes the redacted message regardless of whether it was the last", async () => {
    const room = makeRoom({
      lastMessageEventId: "$msg2",
      lastMessagePreview: "second",
      lastMessageTimestamp: 2000,
      lastMessageSenderId: "user1",
      lastMessageType: MessageType.text,
    });
    await db.rooms.add(room);

    await db.messages.add(makeMsg({ eventId: "$msg1", content: "first",  timestamp: 1000 }));
    await db.messages.add(makeMsg({ eventId: "$msg2", content: "second", timestamp: 2000 }));

    await eventWriter.writeRedaction({ redactedEventId: "$msg1", roomId: ROOM_ID });

    const m1 = await db.messages.where("eventId").equals("$msg1").first();
    expect(m1!.softDeleted).toBe(true);
  });
});
