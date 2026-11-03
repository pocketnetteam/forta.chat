// @vitest-environment happy-dom
/**
 * Web 2026-10-14: a pinned chat lost its pin on every reload. The per-account
 * keys (pinned and muted rooms, unsent read receipts) were bound only by an
 * interactive login or an account switch; a restored session starts Matrix
 * straight from App.vue, so the store kept the shared default key, loaded
 * nothing, and the startup migration moved each new pin out of reach. Unsent
 * read receipts were never saved for the same reason. Matrix start now binds
 * the keys, and an account switch no longer deletes the outgoing account's.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { clearAccountLocalStorage, clearPerAccountKeys } from "@/shared/lib/clear-account-storage";

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => ({
    getUserId: () => "@me:s",
    getRoom: () => null,
    getRooms: () => [],
    isReady: () => false,
    hasLiveSync: () => false,
    getIgnoredMatrixUserIds: () => [] as string[],
    matrixId: (id: string) => id,
  })),
}));

import { useChatStore } from "../chat-store";

describe("per-account chat keys", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
  });

  it("are bound on every Matrix start, before the client exists", () => {
    const auth = readFileSync(resolve(__dirname, "../../../auth/model/stores.ts"), "utf-8");
    const inner = auth.slice(auth.indexOf("const initMatrixInner = async"), auth.indexOf("const initMatrixInner = async") + 2500);
    const bind = inner.indexOf("useChatStore().bindAccountKeys(address.value);");
    expect(bind).toBeGreaterThan(0);
    expect(bind).toBeLessThan(inner.indexOf("matrixService.setCredentials("));
  });

  it("load the account's pinned rooms and fold in pins left under the shared key", () => {
    localStorage.setItem("chat_pinned_rooms:addrA", JSON.stringify(["!a:s"]));
    localStorage.setItem("chat_pinned_rooms", JSON.stringify(["!b:s"]));
    store.bindAccountKeys("addrA");
    expect([...store.pinnedRoomIds].sort()).toEqual(["!a:s", "!b:s"]);
    expect(localStorage.getItem("chat_pinned_rooms")).toBeNull();
    expect(JSON.parse(localStorage.getItem("chat_pinned_rooms:addrA") ?? "[]").sort()).toEqual(["!a:s", "!b:s"]);
  });

  it("keep the sets when the same account is bound again", () => {
    store.bindAccountKeys("addrA");
    store.togglePinRoom("!a:s");
    localStorage.setItem("chat_pinned_rooms:addrA", "[]");
    store.bindAccountKeys("addrA");
    expect(store.pinnedRoomIds.has("!a:s")).toBe(true);
  });

  it("survive an account switch for the outgoing account", () => {
    store.bindAccountKeys("addrA");
    store.togglePinRoom("!a:s");
    localStorage.setItem("chat_pending_read_receipts:addrA", JSON.stringify({ "!a:s": { ts: 1, at: Date.now() } }));
    store.cleanup();
    store.bindAccountKeys("addrB");
    expect(JSON.parse(localStorage.getItem("chat_pinned_rooms:addrA") ?? "[]")).toEqual(["!a:s"]);
    expect(localStorage.getItem("chat_pending_read_receipts:addrA")).not.toBeNull();
    expect(store.pinnedRoomIds.has("!a:s")).toBe(false);
  });

  // Review 2026-10-14: the keys now outlive cleanup(), so removing a
  // background account must delete them itself; and a Matrix retry firing
  // during logout's push unregister would bind them again into the cleaned store.
  it("go away when a background account is removed, and no retry rebinds them during logout", () => {
    localStorage.setItem("chat_pinned_rooms:addrA", "[]");
    localStorage.setItem("chat_muted_rooms:addrA", "[]");
    localStorage.setItem("chat_pending_read_receipts:addrA", "{}");
    localStorage.setItem("chat_pinned_rooms:addrB", "[]");
    clearPerAccountKeys("addrA");
    expect(["chat_pinned_rooms:addrA", "chat_muted_rooms:addrA", "chat_pending_read_receipts:addrA"].map((k) => localStorage.getItem(k))).toEqual([null, null, null]);
    expect(localStorage.getItem("chat_pinned_rooms:addrB")).toBe("[]");

    const auth = readFileSync(resolve(__dirname, "../../../auth/model/stores.ts"), "utf-8");
    const remove = auth.slice(auth.indexOf("const removeAccount = async"), auth.indexOf("const removeAccount = async") + 500);
    expect(remove).toContain("clearPerAccountKeys(targetAddress);");
    const logout = auth.slice(auth.indexOf("const logout = async"), auth.indexOf("const logout = async") + 4000);
    expect(logout.indexOf("stopMatrixReconnect();")).toBeGreaterThan(0);
    expect(logout.indexOf("stopMatrixReconnect();")).toBeLessThan(logout.indexOf("await pushService.unregisterForLogout();"));
  });

  it("go away with the account at logout", () => {
    localStorage.setItem("chat_pinned_rooms:addrA", "[]");
    localStorage.setItem("chat_pending_read_receipts:addrA", "{}");
    clearAccountLocalStorage("addrA");
    expect(localStorage.getItem("chat_pinned_rooms:addrA")).toBeNull();
    expect(localStorage.getItem("chat_pending_read_receipts:addrA")).toBeNull();
  });
});
