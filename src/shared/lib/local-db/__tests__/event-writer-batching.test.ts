import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { ChatDatabase } from "../schema";
import { MessageRepository } from "../message-repository";
import { RoomRepository } from "../room-repository";
import { UserRepository } from "../user-repository";
import { EventWriter, type ParsedMessage } from "../event-writer";
import { MessageType } from "@/entities/chat/model/types";

// WEE-93 regression tests: sync catch-up writes must be batched.
// A1: N events of one flush → 1 Dexie transaction.
// A2/A3: one room-preview write per room per batch, preview = newest message.

let db: ChatDatabase;
let msgRepo: MessageRepository;
let roomRepo: RoomRepository;
let userRepo: UserRepository;

const ROOM_A = "!roomA:server";
const ROOM_B = "!roomB:server";

function makeParsed(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    eventId: overrides.eventId ?? `$evt_${Math.random().toString(36).slice(2)}`,
    roomId: overrides.roomId ?? ROOM_A,
    senderId: overrides.senderId ?? "user1",
    content: overrides.content ?? "hello",
    timestamp: overrides.timestamp ?? Date.now(),
    type: overrides.type ?? MessageType.text,
    ...overrides,
  };
}

function makeWriter(opts?: { onChange?: (roomId: string) => void; fetchPreviewFn?: (url: string) => Promise<null> }) {
  const writer = new EventWriter(db, msgRepo, roomRepo, userRepo, opts?.onChange, opts?.fetchPreviewFn);
  writer.enableBatching();
  return writer;
}

beforeEach(async () => {
  const name = `test-ew-batching-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db = new ChatDatabase(name);
  await db.open();
  msgRepo = new MessageRepository(db);
  roomRepo = new RoomRepository(db);
  userRepo = new UserRepository(db);
});

afterEach(async () => {
  await db.delete();
});

describe("EventWriter batched flush (WEE-93)", () => {
  it("A1: writes a backlog of N messages in a single Dexie transaction", async () => {
    const writer = makeWriter();
    const txSpy = vi.spyOn(db, "transaction");

    for (let i = 0; i < 10; i++) {
      await writer.writeMessageBuffered(
        makeParsed({ timestamp: 1000 + i, content: `msg ${i}` }),
        "me",
        null,
      );
    }
    expect(txSpy).not.toHaveBeenCalled(); // nothing written before flush

    await writer.flushWriteBuffer();

    expect(txSpy).toHaveBeenCalledTimes(1);
    expect(await db.messages.count()).toBe(10);
    await writer.disposeBuffer();
  });

  it("coalesces ensureRoomExists + preview writes to once per unique room", async () => {
    const writer = makeWriter();
    // Pre-create rooms so ensureRoomExists takes the read-only path
    await db.rooms.bulkPut([
      { id: ROOM_A, name: "A", avatar: "", isGroup: false, members: [], membership: "join", unreadCount: 0, topic: "", updatedAt: 0, syncedAt: 0, hasMoreHistory: true, lastReadInboundTs: 0, lastReadOutboundTs: 0, lastMessageReaction: null, isDeleted: false, deletedAt: null, deleteReason: null },
      { id: ROOM_B, name: "B", avatar: "", isGroup: false, members: [], membership: "join", unreadCount: 0, topic: "", updatedAt: 0, syncedAt: 0, hasMoreHistory: true, lastReadInboundTs: 0, lastReadOutboundTs: 0, lastMessageReaction: null, isDeleted: false, deletedAt: null, deleteReason: null },
    ]);

    const previewSpy = vi.spyOn(roomRepo, "updateLastMessage");
    const roomGetSpy = vi.spyOn(db.rooms, "get");

    for (let i = 0; i < 5; i++) {
      await writer.writeMessageBuffered(makeParsed({ roomId: ROOM_A, timestamp: 1000 + i }), "me", null);
      await writer.writeMessageBuffered(makeParsed({ roomId: ROOM_B, timestamp: 2000 + i }), "me", null);
    }
    await writer.flushWriteBuffer();

    // One preview write per room — not one per message (was 10)
    expect(previewSpy).toHaveBeenCalledTimes(2);
    // ensureRoomExists (1 get) + updateLastMessage guard (1 get) per room — not per message (was 20)
    expect(roomGetSpy.mock.calls.length).toBeLessThanOrEqual(4);
    await writer.disposeBuffer();
  });

  it("A3: room preview reflects the NEWEST message even when the batch is out of order", async () => {
    const writer = makeWriter();
    await writer.writeMessageBuffered(makeParsed({ timestamp: 3000, content: "newest" }), "me", null);
    await writer.writeMessageBuffered(makeParsed({ timestamp: 1000, content: "oldest" }), "me", null);
    await writer.writeMessageBuffered(makeParsed({ timestamp: 2000, content: "middle" }), "me", null);
    await writer.flushWriteBuffer();

    const room = await db.rooms.get(ROOM_A);
    expect(room?.lastMessagePreview).toBe("newest");
    expect(room?.lastMessageTimestamp).toBe(3000);

    // All messages persisted, retrievable in timestamp order
    const msgs = await db.messages.where("[roomId+timestamp]")
      .between([ROOM_A, 0], [ROOM_A, Infinity]).toArray();
    expect(msgs.map(m => m.content)).toEqual(["oldest", "middle", "newest"]);
    await writer.disposeBuffer();
  });

  it("A2: onChange fires once per room per flush, not once per message", async () => {
    const onChange = vi.fn();
    const writer = makeWriter({ onChange });

    for (let i = 0; i < 5; i++) {
      await writer.writeMessageBuffered(makeParsed({ roomId: ROOM_A, timestamp: 1000 + i }), "me", null);
    }
    await writer.writeMessageBuffered(makeParsed({ roomId: ROOM_B, timestamp: 5000 }), "me", null);
    await writer.flushWriteBuffer();

    const calls = onChange.mock.calls.map(c => c[0]).sort();
    expect(calls).toEqual([ROOM_A, ROOM_B]);
    await writer.disposeBuffer();
  });

  it("keeps meaningful preview text when the newest batch message is still encrypted", async () => {
    const writer = makeWriter();
    await writer.writeMessageBuffered(
      makeParsed({ timestamp: 1000, content: "plain text" }),
      "me",
      null,
    );
    await writer.writeMessageBuffered(
      makeParsed({ timestamp: 2000, content: "[encrypted]", encryptedRaw: { type: "m.room.encrypted" } }),
      "me",
      null,
    );
    await writer.flushWriteBuffer();

    const room = await db.rooms.get(ROOM_A);
    // Sequential-write parity: plaintext preview preserved, metadata advanced
    expect(room?.lastMessagePreview).toBe("plain text");
    expect(room?.lastMessageTimestamp).toBe(2000);
    expect(room?.lastMessageDecryptionStatus).toBe("pending");
    await writer.disposeBuffer();
  });

  it("fetches link previews for inserted text messages (parity with writeMessage)", async () => {
    const fetchPreviewFn = vi.fn().mockResolvedValue(null);
    const writer = makeWriter({ fetchPreviewFn });

    await writer.writeMessageBuffered(
      makeParsed({ content: "look at https://example.com/page" }),
      "me",
      null,
    );
    await writer.writeMessageBuffered(makeParsed({ content: "no links here" }), "me", null);
    await writer.flushWriteBuffer();

    expect(fetchPreviewFn).toHaveBeenCalledTimes(1);
    expect(fetchPreviewFn).toHaveBeenCalledWith("https://example.com/page");
    await writer.disposeBuffer();
  });

  it("a corrupted message does not abort the rest of the batch", async () => {
    const writer = makeWriter();
    const upsertSpy = vi.spyOn(msgRepo, "upsertFromServer");
    upsertSpy.mockRejectedValueOnce(new Error("corrupt"));

    await writer.writeMessageBuffered(makeParsed({ timestamp: 1000, content: "bad" }), "me", null);
    await writer.writeMessageBuffered(makeParsed({ timestamp: 2000, content: "good" }), "me", null);
    await writer.flushWriteBuffer();

    expect(await db.messages.count()).toBe(1);
    const room = await db.rooms.get(ROOM_A);
    expect(room?.lastMessagePreview).toBe("good");
    await writer.disposeBuffer();
  });
});
