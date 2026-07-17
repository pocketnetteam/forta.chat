import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { ChatDatabase } from "../schema";
import type { LocalMessage } from "../schema";
import { MessageRepository } from "../message-repository";
import { RoomRepository } from "../room-repository";
import { UserRepository } from "../user-repository";
import { EventWriter, type ParsedReaction } from "../event-writer";
import { MessageType } from "@/entities/chat/model/types";

// WEE-93: inbound reactions are buffered and flushed in a single transaction
// (a sync backlog used to cost one read+write round-trip per reaction).

let db: ChatDatabase;
let msgRepo: MessageRepository;
let roomRepo: RoomRepository;
let userRepo: UserRepository;

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
    status: "synced",
    version: 1,
    softDeleted: false,
    ...overrides,
  } as LocalMessage;
}

function makeReaction(overrides: Partial<ParsedReaction> = {}): ParsedReaction {
  return {
    eventId: overrides.eventId ?? `$react_${Math.random().toString(36).slice(2)}`,
    targetEventId: overrides.targetEventId ?? "$target",
    emoji: overrides.emoji ?? "👍",
    senderAddress: overrides.senderAddress ?? "user2",
    isMine: overrides.isMine ?? false,
    ...overrides,
  };
}

beforeEach(async () => {
  const name = `test-ew-reactions-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db = new ChatDatabase(name);
  await db.open();
  msgRepo = new MessageRepository(db);
  roomRepo = new RoomRepository(db);
  userRepo = new UserRepository(db);
});

afterEach(async () => {
  await db.delete();
});

describe("EventWriter buffered reactions (WEE-93)", () => {
  it("flushes N buffered reactions in a single transaction", async () => {
    const writer = new EventWriter(db, msgRepo, roomRepo, userRepo);
    writer.enableBatching();
    await db.messages.bulkAdd([
      makeMsg({ eventId: "$m1", timestamp: 1000 }),
      makeMsg({ eventId: "$m2", timestamp: 2000 }),
    ]);

    const txSpy = vi.spyOn(db, "transaction");
    await writer.writeReaction(makeReaction({ targetEventId: "$m1", emoji: "👍", senderAddress: "a" }));
    await writer.writeReaction(makeReaction({ targetEventId: "$m1", emoji: "👍", senderAddress: "b" }));
    await writer.writeReaction(makeReaction({ targetEventId: "$m1", emoji: "🔥", senderAddress: "a" }));
    await writer.writeReaction(makeReaction({ targetEventId: "$m2", emoji: "❤️", senderAddress: "c" }));
    expect(txSpy).not.toHaveBeenCalled(); // buffered, not yet written

    await writer.flushWriteBuffer();
    expect(txSpy).toHaveBeenCalledTimes(1);

    const m1 = await db.messages.where("eventId").equals("$m1").first();
    expect(m1?.reactions?.["👍"].count).toBe(2);
    expect(m1?.reactions?.["👍"].users.sort()).toEqual(["a", "b"]);
    expect(m1?.reactions?.["🔥"].count).toBe(1);
    const m2 = await db.messages.where("eventId").equals("$m2").first();
    expect(m2?.reactions?.["❤️"].count).toBe(1);
    await writer.disposeBuffer();
  });

  it("tracks myEventId for own reactions through the buffer", async () => {
    const writer = new EventWriter(db, msgRepo, roomRepo, userRepo);
    writer.enableBatching();
    await db.messages.add(makeMsg({ eventId: "$m1" }));

    await writer.writeReaction(makeReaction({
      eventId: "$myreact", targetEventId: "$m1", emoji: "👍", senderAddress: "me", isMine: true,
    }));
    await writer.flushWriteBuffer();

    const m1 = await db.messages.where("eventId").equals("$m1").first();
    expect(m1?.reactions?.["👍"].myEventId).toBe("$myreact");
    await writer.disposeBuffer();
  });

  it("cascades the reaction to the room preview when target is the last message", async () => {
    const writer = new EventWriter(db, msgRepo, roomRepo, userRepo);
    writer.enableBatching();
    await db.messages.add(makeMsg({ eventId: "$last" }));
    await db.rooms.put({
      id: ROOM_ID, name: "Room", avatar: "", isGroup: false, members: [], membership: "join",
      unreadCount: 0, topic: "", updatedAt: 0, syncedAt: 0, hasMoreHistory: true,
      lastReadInboundTs: 0, lastReadOutboundTs: 0, lastMessageReaction: null,
      isDeleted: false, deletedAt: null, deleteReason: null,
      lastMessageEventId: "$last",
    });

    await writer.writeReaction(makeReaction({ targetEventId: "$last", emoji: "🎉", senderAddress: "u9" }));
    await writer.flushWriteBuffer();

    const room = await db.rooms.get(ROOM_ID);
    expect(room?.lastMessageReaction?.emoji).toBe("🎉");
    expect(room?.lastMessageReaction?.senderAddress).toBe("u9");
    await writer.disposeBuffer();
  });

  it("fires onChange once per room per flush", async () => {
    const onChange = vi.fn();
    const writer = new EventWriter(db, msgRepo, roomRepo, userRepo, onChange);
    writer.enableBatching();
    await db.messages.bulkAdd([
      makeMsg({ eventId: "$m1", timestamp: 1000 }),
      makeMsg({ eventId: "$m2", timestamp: 2000 }),
    ]);

    await writer.writeReaction(makeReaction({ targetEventId: "$m1", senderAddress: "a" }));
    await writer.writeReaction(makeReaction({ targetEventId: "$m1", senderAddress: "b" }));
    await writer.writeReaction(makeReaction({ targetEventId: "$m2", senderAddress: "c" }));
    await writer.flushWriteBuffer();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(ROOM_ID);
    await writer.disposeBuffer();
  });

  it("writes immediately when batching is not enabled (fallback path)", async () => {
    const writer = new EventWriter(db, msgRepo, roomRepo, userRepo);
    await db.messages.add(makeMsg({ eventId: "$m1" }));

    await writer.writeReaction(makeReaction({ targetEventId: "$m1", emoji: "👍", senderAddress: "a" }));

    const m1 = await db.messages.where("eventId").equals("$m1").first();
    expect(m1?.reactions?.["👍"].count).toBe(1);
  });

  it("flushes the message buffer first so a reaction to a still-buffered message is not dropped", async () => {
    const writer = new EventWriter(db, msgRepo, roomRepo, userRepo);
    writer.enableBatching();

    // Target message is enqueued but NOT yet flushed to Dexie
    await writer.writeMessageBuffered({
      eventId: "$buffered",
      roomId: ROOM_ID,
      senderId: "user1",
      content: "hi",
      timestamp: 1000,
      type: MessageType.text,
    }, "me", null);
    expect(await db.messages.count()).toBe(0);

    // Force the REACTION buffer to flush (maxSize 100) while the message
    // buffer still holds the target — flushReactions must land messages first.
    for (let i = 0; i < 100; i++) {
      await writer.writeReaction(makeReaction({
        targetEventId: "$buffered",
        emoji: "👍",
        senderAddress: `user_${i}`,
      }));
    }
    // maxSize flush is fire-and-forget — settle pending flush promises
    await writer.flushWriteBuffer();

    const msg = await db.messages.where("eventId").equals("$buffered").first();
    expect(msg).toBeTruthy();
    expect(msg?.reactions?.["👍"].count).toBe(100);
    await writer.disposeBuffer();
  });

  it("drops reactions whose target message is missing without aborting others", async () => {
    const writer = new EventWriter(db, msgRepo, roomRepo, userRepo);
    writer.enableBatching();
    await db.messages.add(makeMsg({ eventId: "$exists" }));

    await writer.writeReaction(makeReaction({ targetEventId: "$ghost", senderAddress: "a" }));
    await writer.writeReaction(makeReaction({ targetEventId: "$exists", emoji: "👍", senderAddress: "a" }));
    await writer.flushWriteBuffer();

    const msg = await db.messages.where("eventId").equals("$exists").first();
    expect(msg?.reactions?.["👍"].count).toBe(1);
    await writer.disposeBuffer();
  });
});
