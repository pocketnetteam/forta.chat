import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { ChatDatabase } from "../schema";
import type { LocalMessage } from "../schema";
import { MessageRepository } from "../message-repository";
import { MessageType } from "@/entities/chat/model/types";

/**
 * WEE-66 / forta-bugs#864, #938 — a deleted message must not linger in the
 * timeline as an undeletable placeholder. `getMessages` is the liveQuery
 * source for the chat window; filtering softDeleted/deleted rows here makes the
 * timeline drop deleted messages, matching the chat-list preview which already
 * uses `getLastNonDeleted` (no more preview-vs-timeline desync, #938).
 */

let db: ChatDatabase;
let repo: MessageRepository;

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

beforeEach(async () => {
  const name = `test-soft-delete-filter-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db = new ChatDatabase(name);
  await db.open();
  repo = new MessageRepository(db);
});

afterEach(async () => {
  await db.delete();
});

describe("MessageRepository.getMessages — excludes deleted rows", () => {
  it("omits soft-deleted messages from the timeline", async () => {
    await db.messages.add(makeMsg({ eventId: "$a", content: "first", timestamp: 1000 }));
    await db.messages.add(makeMsg({ eventId: "$b", content: "gone", timestamp: 2000, softDeleted: true }));
    await db.messages.add(makeMsg({ eventId: "$c", content: "third", timestamp: 3000 }));

    const msgs = await repo.getMessages(ROOM_ID);

    expect(msgs.map((m) => m.eventId)).toEqual(["$a", "$c"]);
  });

  it("omits server-redacted (deleted) messages from the timeline", async () => {
    await db.messages.add(makeMsg({ eventId: "$a", content: "first", timestamp: 1000 }));
    await db.messages.add(makeMsg({ eventId: "$b", content: "", timestamp: 2000, deleted: true }));

    const msgs = await repo.getMessages(ROOM_ID);

    expect(msgs.map((m) => m.eventId)).toEqual(["$a"]);
  });

  it("omits a pending message deleted locally by clientId", async () => {
    await db.messages.add(makeMsg({ eventId: "$a", content: "first", timestamp: 1000 }));
    await db.messages.add(
      makeMsg({ eventId: null, clientId: "pending-1", content: "draft", timestamp: 2000, status: "pending", softDeleted: true }),
    );

    const msgs = await repo.getMessages(ROOM_ID);

    expect(msgs.map((m) => m.clientId)).not.toContain("pending-1");
  });

  it("still returns non-deleted messages in chronological order", async () => {
    await db.messages.add(makeMsg({ eventId: "$a", content: "first", timestamp: 1000 }));
    await db.messages.add(makeMsg({ eventId: "$b", content: "second", timestamp: 2000 }));

    const msgs = await repo.getMessages(ROOM_ID);

    expect(msgs.map((m) => m.content)).toEqual(["first", "second"]);
  });
});

describe("MessageRepository — deleted rows hidden across jump/pagination paths", () => {
  it("getMessagesAfter (forward pagination) omits deleted rows", async () => {
    await db.messages.add(makeMsg({ eventId: "$a", content: "a", timestamp: 1000 }));
    await db.messages.add(makeMsg({ eventId: "$b", content: "gone", timestamp: 2000, softDeleted: true }));
    await db.messages.add(makeMsg({ eventId: "$c", content: "c", timestamp: 3000 }));

    const msgs = await repo.getMessagesAfter(ROOM_ID, 500);

    expect(msgs.map((m) => m.eventId)).toEqual(["$a", "$c"]);
  });

  it("getMessagesAroundTimestamp (jump-to-unread) omits deleted rows", async () => {
    await db.messages.add(makeMsg({ eventId: "$a", content: "a", timestamp: 1000 }));
    await db.messages.add(makeMsg({ eventId: "$b", content: "gone", timestamp: 2000, deleted: true }));
    await db.messages.add(makeMsg({ eventId: "$c", content: "c", timestamp: 3000 }));

    const { messages } = await repo.getMessagesAroundTimestamp(ROOM_ID, 2000);

    expect(messages.map((m) => m.eventId)).toEqual(["$a", "$c"]);
  });

  it("getMessageContext omits deleted rows around the target", async () => {
    await db.messages.add(makeMsg({ eventId: "$a", content: "a", timestamp: 1000 }));
    await db.messages.add(makeMsg({ eventId: "$b", content: "gone", timestamp: 2000, softDeleted: true }));
    await db.messages.add(makeMsg({ eventId: "$target", content: "target", timestamp: 3000 }));

    const ctx = await repo.getMessageContext(ROOM_ID, "$target");

    expect(ctx).not.toBeNull();
    expect(ctx!.messages.map((m) => m.eventId)).toEqual(["$a", "$target"]);
  });

  it("getMessageContext returns null when the target itself is deleted", async () => {
    await db.messages.add(makeMsg({ eventId: "$target", content: "", timestamp: 3000, softDeleted: true }));

    const ctx = await repo.getMessageContext(ROOM_ID, "$target");

    expect(ctx).toBeNull();
  });
});
