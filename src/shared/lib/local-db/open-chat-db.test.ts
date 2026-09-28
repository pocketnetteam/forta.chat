import { afterEach, describe, expect, it, vi } from "vitest";
import { openChatDb } from "./open-chat-db";

/**
 * Audit S3-04. Dexie opens lazily, and nothing on the start path awaited an
 * operation that could fail, so a database that could not open (no space,
 * Safari private mode, a corrupted store, an upgrade blocked by another tab)
 * left an empty, inert chat list with no error at all. openChatDb opens it
 * explicitly and bounds the wait — Dexie's "blocked" open never settles.
 */
describe("openChatDb", () => {
  afterEach(() => vi.useRealTimers());

  it("resolves once the database is open", async () => {
    const db = { open: vi.fn(async () => undefined) };
    await expect(openChatDb(db)).resolves.toBeUndefined();
    expect(db.open).toHaveBeenCalledTimes(1);
  });

  it("rejects when the database cannot open", async () => {
    const quota = Object.assign(new Error("QuotaExceededError"), { name: "QuotaExceededError" });
    const db = { open: vi.fn(async () => { throw quota; }) };
    await expect(openChatDb(db)).rejects.toBe(quota);
  });

  it("rejects instead of hanging when the open never settles", async () => {
    vi.useFakeTimers();
    const db = { open: vi.fn(() => new Promise<void>(() => {})) };
    const pending = openChatDb(db, 5_000);
    const assertion = expect(pending).rejects.toThrow(/local database open/);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });
});
