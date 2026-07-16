import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "fake-indexeddb/auto";
import { ChatDatabase } from "../schema";
import { UserRepository } from "../user-repository";
import { initChatDb, closeChatDb, readUserAliases } from "../index";

/**
 * WEE-102 — direct coverage for `readUserAliases`, the network-independent
 * Dexie read used to hydrate local contact aliases at cold boot / offline.
 *
 * Two branches:
 *   - cold: no live kit → open a short-lived ChatDatabase, read, close it.
 *   - warm: a kit is already open for this user → reuse its connection.
 * Plus the finally-closes-on-error contract.
 */
describe("readUserAliases", () => {
  const USER = "PselfAddr";

  beforeEach(async () => {
    closeChatDb();
    await new ChatDatabase(USER).delete();
  });

  afterEach(() => {
    closeChatDb();
  });

  it("cold branch: reads aliases from Dexie with no live kit", async () => {
    // Seed via a throwaway connection, then close it so no kit is open.
    const seed = new ChatDatabase(USER);
    await new UserRepository(seed).setAlias("Pmama", "Мама", 111);
    await new UserRepository(seed).setAlias("Ppapa", "Папа", 222);
    seed.close();

    const aliases = await readUserAliases(USER);

    expect(aliases).toEqual({
      Pmama: { alias: "Мама", updatedAt: 111 },
      Ppapa: { alias: "Папа", updatedAt: 222 },
    });
  });

  it("cold branch: closes the short-lived connection after the read", async () => {
    const closeSpy = vi.spyOn(ChatDatabase.prototype, "close");
    try {
      await readUserAliases(USER);
      expect(closeSpy).toHaveBeenCalled();
    } finally {
      closeSpy.mockRestore();
    }
  });

  it("cold branch: still closes the connection when the read throws", async () => {
    const closeSpy = vi.spyOn(ChatDatabase.prototype, "close");
    const getAllSpy = vi
      .spyOn(UserRepository.prototype, "getAllAliases")
      .mockRejectedValueOnce(new Error("Dexie blew up"));
    try {
      await expect(readUserAliases(USER)).rejects.toThrow("Dexie blew up");
      expect(closeSpy).toHaveBeenCalled();
    } finally {
      getAllSpy.mockRestore();
      closeSpy.mockRestore();
    }
  });

  it("warm branch: reuses the live kit and does NOT open/close a new connection", async () => {
    const kit = initChatDb(USER, async () => undefined);
    await kit.users.setAlias("Pfriend", "Друг", 333);

    const closeSpy = vi.spyOn(ChatDatabase.prototype, "close");
    try {
      const aliases = await readUserAliases(USER);
      expect(aliases).toEqual({ Pfriend: { alias: "Друг", updatedAt: 333 } });
      // Reuse path must not tear down a connection — that would close the live kit.
      expect(closeSpy).not.toHaveBeenCalled();
    } finally {
      closeSpy.mockRestore();
    }
    // Let initChatDb's immediate background work (processQueue / recovery ticks)
    // settle against the still-open DB so afterEach's close doesn't race it into
    // a benign DatabaseClosedError unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("returns an empty map when the user has no aliases", async () => {
    expect(await readUserAliases(USER)).toEqual({});
  });
});
