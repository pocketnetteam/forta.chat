import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { ChatDatabase } from "../schema";
import type { LocalMessage } from "../schema";
import { MessageRepository } from "../message-repository";
import { MessageType } from "@/entities/chat/model/types";

/**
 * WEE-81 (narrows WEE-66 / forta-bugs#864, #938) — the timeline read paths
 * must KEEP server-redacted messages (softDeleted/deleted WITH a real eventId)
 * so they render the «Сообщение удалено» placeholder; a Matrix redaction
 * reaches every participant and can't be hidden. The ONLY row dropped is the
 * local-only phantom (eventId == null + deleted): a pending message the user
 * deleted before it ever synced, which leaves no trace for the peer either.
 *
 * WEE-66 originally filtered ALL deleted rows here, which over-removed the
 * legitimate placeholder (the regression WEE-81 fixes). These tests assert the
 * corrected, narrowed behavior.
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

describe("MessageRepository.getMessages — keeps redacted placeholder, drops phantom", () => {
  it("keeps soft-deleted messages that have an eventId (server-redacted → placeholder)", async () => {
    await db.messages.add(makeMsg({ eventId: "$a", content: "first", timestamp: 1000 }));
    await db.messages.add(makeMsg({ eventId: "$b", content: "", timestamp: 2000, softDeleted: true }));
    await db.messages.add(makeMsg({ eventId: "$c", content: "third", timestamp: 3000 }));

    const msgs = await repo.getMessages(ROOM_ID);

    expect(msgs.map((m) => m.eventId)).toEqual(["$a", "$b", "$c"]);
  });

  it("keeps server-redacted (deleted flag) messages that have an eventId", async () => {
    await db.messages.add(makeMsg({ eventId: "$a", content: "first", timestamp: 1000 }));
    await db.messages.add(makeMsg({ eventId: "$b", content: "", timestamp: 2000, deleted: true }));

    const msgs = await repo.getMessages(ROOM_ID);

    expect(msgs.map((m) => m.eventId)).toEqual(["$a", "$b"]);
  });

  it("omits a pending phantom deleted locally by clientId (eventId null + softDeleted)", async () => {
    await db.messages.add(makeMsg({ eventId: "$a", content: "first", timestamp: 1000 }));
    await db.messages.add(
      makeMsg({ eventId: null, clientId: "pending-1", content: "draft", timestamp: 2000, status: "pending", softDeleted: true }),
    );

    const msgs = await repo.getMessages(ROOM_ID);

    expect(msgs.map((m) => m.clientId)).not.toContain("pending-1");
    expect(msgs.map((m) => m.eventId)).toEqual(["$a"]);
  });

  it("still returns non-deleted messages in chronological order", async () => {
    await db.messages.add(makeMsg({ eventId: "$a", content: "first", timestamp: 1000 }));
    await db.messages.add(makeMsg({ eventId: "$b", content: "second", timestamp: 2000 }));

    const msgs = await repo.getMessages(ROOM_ID);

    expect(msgs.map((m) => m.content)).toEqual(["first", "second"]);
  });
});

describe("MessageRepository — redacted placeholder preserved across jump/pagination paths", () => {
  it("getMessagesAfter (forward pagination) keeps server-redacted rows", async () => {
    await db.messages.add(makeMsg({ eventId: "$a", content: "a", timestamp: 1000 }));
    await db.messages.add(makeMsg({ eventId: "$b", content: "", timestamp: 2000, softDeleted: true }));
    await db.messages.add(makeMsg({ eventId: "$c", content: "c", timestamp: 3000 }));

    const msgs = await repo.getMessagesAfter(ROOM_ID, 500);

    expect(msgs.map((m) => m.eventId)).toEqual(["$a", "$b", "$c"]);
  });

  it("getMessagesAfter still drops a local-only phantom", async () => {
    await db.messages.add(makeMsg({ eventId: "$a", content: "a", timestamp: 1000 }));
    await db.messages.add(
      makeMsg({ eventId: null, clientId: "ph", content: "", timestamp: 2000, status: "pending", softDeleted: true }),
    );

    const msgs = await repo.getMessagesAfter(ROOM_ID, 500);

    expect(msgs.map((m) => m.clientId)).not.toContain("ph");
  });

  it("getMessagesAroundTimestamp (jump-to-unread) keeps server-redacted rows", async () => {
    await db.messages.add(makeMsg({ eventId: "$a", content: "a", timestamp: 1000 }));
    await db.messages.add(makeMsg({ eventId: "$b", content: "", timestamp: 2000, deleted: true }));
    await db.messages.add(makeMsg({ eventId: "$c", content: "c", timestamp: 3000 }));

    const { messages } = await repo.getMessagesAroundTimestamp(ROOM_ID, 2000);

    expect(messages.map((m) => m.eventId)).toEqual(["$a", "$b", "$c"]);
  });

  it("getMessageContext keeps server-redacted rows around the target", async () => {
    await db.messages.add(makeMsg({ eventId: "$a", content: "a", timestamp: 1000 }));
    await db.messages.add(makeMsg({ eventId: "$b", content: "", timestamp: 2000, softDeleted: true }));
    await db.messages.add(makeMsg({ eventId: "$target", content: "target", timestamp: 3000 }));

    const ctx = await repo.getMessageContext(ROOM_ID, "$target");

    expect(ctx).not.toBeNull();
    expect(ctx!.messages.map((m) => m.eventId)).toEqual(["$a", "$b", "$target"]);
  });

  it("getMessageContext allows jumping to a server-redacted target (renders placeholder)", async () => {
    await db.messages.add(makeMsg({ eventId: "$prev", content: "prev", timestamp: 2000 }));
    await db.messages.add(makeMsg({ eventId: "$target", content: "", timestamp: 3000, softDeleted: true }));

    const ctx = await repo.getMessageContext(ROOM_ID, "$target");

    expect(ctx).not.toBeNull();
    expect(ctx!.messages.map((m) => m.eventId)).toContain("$target");
  });
});
