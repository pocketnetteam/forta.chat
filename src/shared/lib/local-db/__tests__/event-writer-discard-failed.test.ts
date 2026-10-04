import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { ChatDatabase } from "../schema";
import type { LocalMessage, LocalRoom, PendingOperation } from "../schema";
import { MessageRepository } from "../message-repository";
import { RoomRepository } from "../room-repository";
import { UserRepository } from "../user-repository";
import { EventWriter } from "../event-writer";
import { MessageType } from "@/entities/chat/model/types";

// «Отменить» on a failed bubble: the message never reached the server, so it
// leaves the timeline and the queue, and the chat-list preview rolls back.

let db: ChatDatabase;
let eventWriter: EventWriter;

const ROOM_ID = "!room:server";

function makeMsg(overrides: Partial<LocalMessage> = {}): LocalMessage {
  return {
    eventId: `$evt_${Math.random().toString(36).slice(2)}`,
    clientId: `cli_${Math.random().toString(36).slice(2)}`,
    roomId: ROOM_ID,
    senderId: "me",
    content: "hello",
    timestamp: 1000,
    type: MessageType.text,
    status: "synced",
    version: 1,
    softDeleted: false,
    ...overrides,
  } as LocalMessage;
}

function makeRoom(overrides: Partial<LocalRoom> = {}): LocalRoom {
  return {
    id: ROOM_ID,
    name: "Test Room",
    isGroup: false,
    members: ["me", "peer"],
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

function makeOp(clientId: string, status: PendingOperation["status"]): PendingOperation {
  return {
    type: "send_message",
    roomId: ROOM_ID,
    payload: { content: "324" },
    status,
    retries: 5,
    maxRetries: 5,
    createdAt: 2000,
    clientId,
  };
}

const failed = () => makeMsg({ eventId: null, clientId: "cli_failed", content: "324", timestamp: 2000, status: "failed" });

beforeEach(async () => {
  db = new ChatDatabase(`test-discard-failed-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await db.open();
  const msgRepo = new MessageRepository(db);
  eventWriter = new EventWriter(db, msgRepo, new RoomRepository(db), new UserRepository(db));
});

afterEach(async () => {
  await db.delete();
});

describe("EventWriter.discardFailedMessage", () => {
  it("removes the message and its queued ops and rolls the preview back to the previous message", async () => {
    await db.messages.bulkAdd([
      makeMsg({ eventId: "$prev", content: "earlier", timestamp: 1000, senderId: "peer" }),
      failed(),
    ]);
    await db.pendingOps.bulkAdd([makeOp("cli_failed", "failed"), makeOp("cli_other", "failed")]);
    await db.rooms.add(makeRoom({
      lastMessageEventId: "$prev",
      lastMessagePreview: "324",
      lastMessageTimestamp: 2000,
      lastMessageSenderId: "me",
      lastMessageLocalStatus: "failed",
    }));

    expect(await eventWriter.discardFailedMessage("cli_failed")).toBe(true);

    expect(await db.messages.where("clientId").equals("cli_failed").count()).toBe(0);
    expect((await db.pendingOps.toArray()).map((op) => op.clientId)).toEqual(["cli_other"]);
    const room = await db.rooms.get(ROOM_ID);
    expect(room?.lastMessagePreview).toBe("earlier");
    expect(room?.lastMessageTimestamp).toBe(1000);
    expect(room?.lastMessageSenderId).toBe("peer");
    expect(room?.lastMessageLocalStatus).toBe("synced");
  });

  it("skips deleted messages and cancelled uploads when rolling back", async () => {
    await db.messages.bulkAdd([
      makeMsg({ eventId: "$prev", content: "earlier", timestamp: 1000 }),
      makeMsg({ eventId: "$gone", content: "gone", timestamp: 1200, softDeleted: true }),
      makeMsg({ eventId: null, clientId: "cli_upload", type: MessageType.image, timestamp: 1500, status: "cancelled" }),
      failed(),
    ]);
    await db.rooms.add(makeRoom({ lastMessagePreview: "324", lastMessageTimestamp: 2000, lastMessageLocalStatus: "failed" }));

    expect(await eventWriter.discardFailedMessage("cli_failed")).toBe(true);

    expect((await db.rooms.get(ROOM_ID))?.lastMessagePreview).toBe("earlier");
  });

  it("clears the preview when the failed message was the only one", async () => {
    await db.messages.add(failed());
    await db.rooms.add(makeRoom({ lastMessagePreview: "324", lastMessageTimestamp: 2000, lastMessageLocalStatus: "failed" }));

    expect(await eventWriter.discardFailedMessage("cli_failed")).toBe(true);

    const room = await db.rooms.get(ROOM_ID);
    expect(room?.lastMessagePreview).toBeUndefined();
    expect(room?.lastMessageLocalStatus).toBeUndefined();
  });

  it("leaves a newer preview alone", async () => {
    await db.messages.bulkAdd([failed(), makeMsg({ eventId: "$newer", content: "newer", timestamp: 3000 })]);
    await db.rooms.add(makeRoom({ lastMessageEventId: "$newer", lastMessagePreview: "newer", lastMessageTimestamp: 3000 }));

    expect(await eventWriter.discardFailedMessage("cli_failed")).toBe(true);

    expect((await db.rooms.get(ROOM_ID))?.lastMessagePreview).toBe("newer");
  });

  it("refuses while a send for the message is in flight", async () => {
    await db.messages.add(failed());
    await db.pendingOps.add(makeOp("cli_failed", "syncing"));

    expect(await eventWriter.discardFailedMessage("cli_failed")).toBe(false);

    expect(await db.messages.where("clientId").equals("cli_failed").count()).toBe(1);
    expect(await db.pendingOps.count()).toBe(1);
  });

  it("refuses a message that is not failed or already reached the server", async () => {
    await db.messages.bulkAdd([
      makeMsg({ eventId: null, clientId: "cli_pending", status: "pending" }),
      makeMsg({ eventId: "$sent", clientId: "cli_sent", status: "failed" }),
    ]);

    expect(await eventWriter.discardFailedMessage("cli_pending")).toBe(false);
    expect(await eventWriter.discardFailedMessage("cli_sent")).toBe(false);
    expect(await db.messages.count()).toBe(2);
  });
});
