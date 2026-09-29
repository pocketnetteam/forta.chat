import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { ChatDatabase, type LocalMessage } from "../schema";
import { MessageRepository, reactionsEqual } from "../message-repository";
import { MessageType } from "@/entities/chat/model/types";

/**
 * A history reload used to call updateReactions — one rw transaction — for
 * every message with reactions on every room open, changed or not (plan
 * 2026-09-28-chat-open-local-first, stage 2). bulkUpdateReactions writes in
 * one transaction and only rows whose reactions differ.
 */

const ROOM = "!room:server";
let db: ChatDatabase;
let repo: MessageRepository;

const message = (eventId: string, reactions?: LocalMessage["reactions"]): LocalMessage => ({
  eventId,
  clientId: `srv_${eventId}`,
  roomId: ROOM,
  senderId: "peer",
  content: "hi",
  timestamp: 1000,
  type: MessageType.text,
  status: "synced",
  version: 1,
  softDeleted: false,
  reactions,
});

beforeEach(async () => {
  db = new ChatDatabase(`test-bulk-reactions-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await db.open();
  repo = new MessageRepository(db);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.delete();
});

describe("MessageRepository.bulkUpdateReactions", () => {
  it("writes only rows whose reactions changed, in one transaction", async () => {
    const same = { "👍": { count: 1, users: ["a"] } };
    await db.messages.bulkAdd([message("$same", same), message("$changed", same), message("$none")]);
    const updates: unknown[] = [];
    const onUpdate = (mods: unknown) => { updates.push(mods); };
    db.messages.hook("updating", onUpdate);
    const transaction = vi.spyOn(db, "transaction");

    const written = await repo.bulkUpdateReactions([
      { eventId: "$same", reactions: { "👍": { count: 1, users: ["a"] } } },
      { eventId: "$changed", reactions: { "👍": { count: 2, users: ["a", "b"] } } },
      { eventId: "$none", reactions: { "🔥": { count: 1, users: ["c"] } } },
      { eventId: "$missing", reactions: { "🔥": { count: 1, users: ["c"] } } },
    ]);

    db.messages.hook("updating").unsubscribe(onUpdate);
    expect(written).toBe(2);
    expect(updates).toHaveLength(2);
    expect(transaction).toHaveBeenCalledTimes(1);
    const changed = await db.messages.where("eventId").equals("$changed").first();
    expect(changed?.reactions?.["👍"].users).toEqual(["a", "b"]);
  });

  it("opens no write transaction when nothing changed", async () => {
    await db.messages.bulkAdd([message("$a", { "👍": { count: 2, users: ["x", "y"] } })]);
    const transaction = vi.spyOn(db, "transaction");

    const written = await repo.bulkUpdateReactions([
      { eventId: "$a", reactions: { "👍": { count: 2, users: ["y", "x"] } } },
    ]);

    expect(written).toBe(0);
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("reactionsEqual", () => {
  it("ignores user order and zero-count emojis", () => {
    expect(reactionsEqual(
      { "👍": { count: 2, users: ["a", "b"] }, "🔥": { count: 0, users: [] } },
      { "👍": { count: 2, users: ["b", "a"] } },
    )).toBe(true);
  });

  it("treats a missing map as empty", () => {
    expect(reactionsEqual(undefined, {})).toBe(true);
    expect(reactionsEqual(undefined, { "👍": { count: 1, users: ["a"] } })).toBe(false);
  });

  it("sees a changed own reaction event id", () => {
    expect(reactionsEqual(
      { "👍": { count: 1, users: ["me"], myEventId: "~local" } },
      { "👍": { count: 1, users: ["me"], myEventId: "$server" } },
    )).toBe(false);
  });
});
