import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { ChatDatabase } from "../schema";
import type { LocalMessage, LocalRoom } from "../schema";
import { MessageRepository } from "../message-repository";
import { RoomRepository } from "../room-repository";
import { UserRepository } from "../user-repository";
import { EventWriter, type ParsedMessage } from "../event-writer";
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
  const name = `test-edit-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

describe("edit-handling", () => {
  // -------------------------------------------------------------------------
  // MessageRepository.editLocal
  // -------------------------------------------------------------------------
  describe("MessageRepository.editLocal", () => {
    it("updates content, sets edited=true, increments version", async () => {
      const msg = makeMsg({ eventId: "$msg1", content: "original", version: 1 });
      await db.messages.add(msg);

      await msgRepo.editLocal("$msg1", "updated text");

      const stored = await db.messages.where("eventId").equals("$msg1").first();
      expect(stored!.content).toBe("updated text");
      expect(stored!.edited).toBe(true);
      expect(stored!.version).toBe(2);
    });

    it("sets lastEditTs when provided", async () => {
      const msg = makeMsg({ eventId: "$msg2", content: "original", version: 1 });
      await db.messages.add(msg);

      await msgRepo.editLocal("$msg2", "edited", 1000);

      const stored = await db.messages.where("eventId").equals("$msg2").first();
      expect(stored!.lastEditTs).toBe(1000);
    });

    it("skips stale edit when editTs < lastEditTs", async () => {
      const msg = makeMsg({
        eventId: "$msg3",
        content: "latest edit",
        version: 2,
        lastEditTs: 2000,
      });
      await db.messages.add(msg);

      // Try to apply an older edit
      await msgRepo.editLocal("$msg3", "stale edit", 1000);

      const stored = await db.messages.where("eventId").equals("$msg3").first();
      expect(stored!.content).toBe("latest edit"); // unchanged
      expect(stored!.version).toBe(2); // unchanged
      expect(stored!.lastEditTs).toBe(2000); // unchanged
    });

    it("applies edit when editTs > lastEditTs", async () => {
      const msg = makeMsg({
        eventId: "$msg4",
        content: "first edit",
        version: 2,
        lastEditTs: 1000,
      });
      await db.messages.add(msg);

      await msgRepo.editLocal("$msg4", "second edit", 2000);

      const stored = await db.messages.where("eventId").equals("$msg4").first();
      expect(stored!.content).toBe("second edit");
      expect(stored!.version).toBe(3);
      expect(stored!.lastEditTs).toBe(2000);
    });

    it("is idempotent — re-applying same content is harmless", async () => {
      const msg = makeMsg({ eventId: "$msg5", content: "text", version: 1 });
      await db.messages.add(msg);

      await msgRepo.editLocal("$msg5", "edited");
      await msgRepo.editLocal("$msg5", "edited");

      const stored = await db.messages.where("eventId").equals("$msg5").first();
      expect(stored!.content).toBe("edited");
      // version incremented twice — acceptable, no functional issue
      expect(stored!.version).toBe(3);
    });

    it("no-ops when eventId does not exist", async () => {
      // Should not throw
      await msgRepo.editLocal("$nonexistent", "text");
      const count = await db.messages.count();
      expect(count).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // EventWriter.writeEdit — room preview update
  // -------------------------------------------------------------------------
  describe("EventWriter.writeEdit — room preview", () => {
    it("updates room preview when edit targets the last message", async () => {
      const room = makeRoom({
        lastMessageEventId: "$msg1",
        lastMessagePreview: "original text",
      });
      await db.rooms.add(room);

      const msg = makeMsg({ eventId: "$msg1", content: "original text" });
      await db.messages.add(msg);

      await eventWriter.writeEdit(ROOM_ID, {
        senderId: "user1",
        targetEventId: "$msg1",
        newContent: "edited text",
      });

      const updatedRoom = await roomRepo.getRoom(ROOM_ID);
      expect(updatedRoom!.lastMessagePreview).toBe("edited text");

      const updatedMsg = await db.messages.where("eventId").equals("$msg1").first();
      expect(updatedMsg!.content).toBe("edited text");
      expect(updatedMsg!.edited).toBe(true);
    });

    it("does NOT update room preview when edit targets a non-last message", async () => {
      const room = makeRoom({
        lastMessageEventId: "$msg2",
        lastMessagePreview: "latest message",
      });
      await db.rooms.add(room);

      const msg1 = makeMsg({ eventId: "$msg1", content: "older message" });
      await db.messages.add(msg1);
      const msg2 = makeMsg({ eventId: "$msg2", content: "latest message" });
      await db.messages.add(msg2);

      await eventWriter.writeEdit(ROOM_ID, {
        senderId: "user1",
        targetEventId: "$msg1",
        newContent: "edited older",
      });

      const updatedRoom = await roomRepo.getRoom(ROOM_ID);
      expect(updatedRoom!.lastMessagePreview).toBe("latest message"); // unchanged
    });
  });

  // -------------------------------------------------------------------------
  // EventWriter.writeEdit — pending edits (arrival order)
  // -------------------------------------------------------------------------
  describe("EventWriter.writeEdit — pending edits", () => {
    it("stashes edit when base message not yet in Dexie", async () => {
      const room = makeRoom();
      await db.rooms.add(room);

      // Edit arrives before base message
      await eventWriter.writeEdit(ROOM_ID, {
        senderId: "user1",
        targetEventId: "$future_msg",
        newContent: "edited before arrival",
      });

      // No message in DB yet — nothing to update
      const count = await db.messages.count();
      expect(count).toBe(0);
    });

    it("applies stashed edit when base message is later written", async () => {
      const room = makeRoom({
        lastMessageEventId: "$future_msg",
        lastMessagePreview: "original",
      });
      await db.rooms.add(room);

      // 1. Edit arrives first
      await eventWriter.writeEdit(ROOM_ID, {
        senderId: "user1",
        targetEventId: "$future_msg",
        newContent: "edited text",
      });

      // 2. Base message arrives later via writeMessage
      const parsed: ParsedMessage = {
        eventId: "$future_msg",
        roomId: ROOM_ID,
        senderId: "user1",
        content: "original",
        timestamp: Date.now(),
        type: MessageType.text,
      };
      await eventWriter.writeMessage(parsed, "me", null);

      // 3. The stashed edit should have been applied
      const stored = await db.messages.where("eventId").equals("$future_msg").first();
      expect(stored!.content).toBe("edited text");
      expect(stored!.edited).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Who may edit (review 2026-10-08, H4): only the author, only in the
  // target's room. Any room member could rewrite another member's message on
  // every other client, and an edit sent in one room could rewrite a message
  // of another room found by its event id.
  // -------------------------------------------------------------------------
  describe("EventWriter.writeEdit — only the author, in the target's room", () => {
    it("ignores an edit from another sender", async () => {
      await db.messages.add(makeMsg({ eventId: "$theirs", senderId: "user1", content: "original" }));

      await eventWriter.writeEdit(ROOM_ID, { senderId: "user2", targetEventId: "$theirs", newContent: "forged" });

      const stored = await db.messages.where("eventId").equals("$theirs").first();
      expect(stored!.content).toBe("original");
      expect(stored!.edited).toBeFalsy();
    });

    it("ignores an edit sent in another room", async () => {
      await db.messages.add(makeMsg({ eventId: "$elsewhere", roomId: "!other:server", senderId: "user1", content: "original" }));

      await eventWriter.writeEdit(ROOM_ID, { senderId: "user1", targetEventId: "$elsewhere", newContent: "forged" });

      const stored = await db.messages.where("eventId").equals("$elsewhere").first();
      expect(stored!.content).toBe("original");
    });

    it("drops a stashed edit from another sender when its target lands", async () => {
      await db.rooms.add(makeRoom());
      await eventWriter.writeEdit(ROOM_ID, { senderId: "user2", targetEventId: "$later", newContent: "forged" });

      await eventWriter.writeMessage(
        { eventId: "$later", roomId: ROOM_ID, senderId: "user1", content: "original", timestamp: Date.now(), type: MessageType.text },
        "me",
        null,
      );

      const stored = await db.messages.where("eventId").equals("$later").first();
      expect(stored!.content).toBe("original");
    });

    it("a forged stashed edit does not push out the author's stashed edit", async () => {
      await db.rooms.add(makeRoom());
      await eventWriter.writeEdit(ROOM_ID, { senderId: "user1", targetEventId: "$both", newContent: "author's edit" });
      await eventWriter.writeEdit(ROOM_ID, { senderId: "user2", targetEventId: "$both", newContent: "forged" });

      await eventWriter.writeMessage(
        { eventId: "$both", roomId: ROOM_ID, senderId: "user1", content: "original", timestamp: Date.now(), type: MessageType.text },
        "me",
        null,
      );

      const stored = await db.messages.where("eventId").equals("$both").first();
      expect(stored!.content).toBe("author's edit");
    });

    it("drops a stashed edit sent in another room when its target lands", async () => {
      await db.rooms.add(makeRoom({ id: "!other:server" }));
      await eventWriter.writeEdit(ROOM_ID, { senderId: "user1", targetEventId: "$later2", newContent: "forged" });

      await eventWriter.writeMessage(
        { eventId: "$later2", roomId: "!other:server", senderId: "user1", content: "original", timestamp: Date.now(), type: MessageType.text },
        "me",
        null,
      );

      const stored = await db.messages.where("eventId").equals("$later2").first();
      expect(stored!.content).toBe("original");
    });
  });

  // -------------------------------------------------------------------------
  // No duplicates
  // -------------------------------------------------------------------------
  describe("no duplicate messages from edits", () => {
    it("edit does not create a new message row", async () => {
      const msg = makeMsg({ eventId: "$msg1", content: "original" });
      await db.messages.add(msg);

      await eventWriter.writeEdit(ROOM_ID, {
        senderId: "user1",
        targetEventId: "$msg1",
        newContent: "edited",
      });

      const all = await db.messages.where("roomId").equals(ROOM_ID).toArray();
      expect(all.length).toBe(1);
      expect(all[0].content).toBe("edited");
    });
  });
});
