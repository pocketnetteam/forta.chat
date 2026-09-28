import { describe, it, expect, afterEach, vi } from "vitest";
import "fake-indexeddb/auto";
import { initChatDb, deleteChatDb, getChatDb, isChatDbReady } from "../index";

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: () => ({ isReady: () => false }),
}));

/**
 * Audit S10-08: logout awaited deleteChatDb(), and with the database open in
 * another tab Dexie's delete() never settles — logout hung for good.
 */
describe("deleteChatDb", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("finishes logout when another connection blocks the deletion", async () => {
    const userId = `blocked-delete-${Date.now()}`;
    initChatDb(userId, async () => undefined);
    await getChatDb().db.open();

    // Another tab: a raw connection that does not close on versionchange.
    const other = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(`bastyon-chat-${userId}`);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    other.onversionchange = () => {};

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(deleteChatDb(50)).resolves.toBeUndefined();
    expect(isChatDbReady()).toBe(false);
    expect(warn).toHaveBeenCalled();

    other.close();
    warn.mockRestore();
  });

  it("is a no-op without an open database", async () => {
    await expect(deleteChatDb(50)).resolves.toBeUndefined();
  });
});
