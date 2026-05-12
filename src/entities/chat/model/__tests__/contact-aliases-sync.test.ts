import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { useChatStore } from "../chat-store";

/**
 * Regression tests for Session 51 — cross-device alias sync.
 *
 * Aliases set on device A propagate to device B via the global
 * m.bastyon.contact_aliases account_data event. Conflict resolution is
 * last-write-wins by the embedded `updatedAt` timestamp:
 *
 *   - Incoming entry with updatedAt > local aliasUpdatedAt  → apply.
 *   - Incoming entry with updatedAt <= local aliasUpdatedAt → ignore.
 *
 * Tombstones (incoming { name: "", updatedAt: ... }) clear the local alias
 * when the timestamp is newer.
 *
 * The handler is exposed as chatStore.handleAccountDataEvent so the auth
 * layer can wire it to both the SDK's "accountData" event AND the
 * cold-start replay during login.
 */

/** Fake Matrix event-like object shaped for the handler. */
function makeEvent(content: { aliases?: Record<string, { name: string; updatedAt: number }> }) {
  return {
    getType: () => "m.bastyon.contact_aliases",
    getContent: () => content,
  };
}

describe("contact aliases — cross-device account_data sync", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
  });

  it("exposes handleAccountDataEvent", () => {
    expect(typeof store.handleAccountDataEvent).toBe("function");
  });

  it("ignores events of unrelated types", async () => {
    store.localAliases["addr1"] = "Existing";
    const ev = {
      getType: () => "m.fully_read",
      getContent: () => ({ aliases: { addr1: { name: "Should Not Apply", updatedAt: 9999 } } }),
    };
    await store.handleAccountDataEvent(ev);
    expect(store.getLocalAlias("addr1")).toBe("Existing");
  });

  it("applies incoming alias when there is no local entry yet", async () => {
    const ev = makeEvent({ aliases: { addr1: { name: "New", updatedAt: 2000 } } });
    await store.handleAccountDataEvent(ev);
    expect(store.getLocalAlias("addr1")).toBe("New");
  });

  it("applies incoming alias when newer than local (LWW)", async () => {
    // Local set far in the past
    await store.setContactAlias("addr1", "Old");
    // Force the in-memory alias to mimic an aged record
    store.localAliases["addr1"] = "Old";
    const ev = makeEvent({ aliases: { addr1: { name: "New", updatedAt: Date.now() + 10_000 } } });
    await store.handleAccountDataEvent(ev);
    expect(store.getLocalAlias("addr1")).toBe("New");
  });

  it("ignores stale incoming alias (LWW — local timestamp is newer)", async () => {
    await store.setContactAlias("addr1", "Local Newer");
    const staleTs = Date.now() - 100_000;
    const ev = makeEvent({ aliases: { addr1: { name: "Server Older", updatedAt: staleTs } } });
    await store.handleAccountDataEvent(ev);
    expect(store.getLocalAlias("addr1")).toBe("Local Newer");
  });

  it("applies tombstone (empty name + newer timestamp) by clearing alias", async () => {
    store.localAliases["addr1"] = "Existing";
    const ev = makeEvent({ aliases: { addr1: { name: "", updatedAt: Date.now() + 5000 } } });
    await store.handleAccountDataEvent(ev);
    expect(store.getLocalAlias("addr1")).toBeNull();
  });

  it("applies multiple aliases in one event", async () => {
    const ev = makeEvent({
      aliases: {
        a1: { name: "Alice", updatedAt: 1000 },
        a2: { name: "Bob", updatedAt: 2000 },
        a3: { name: "Carol", updatedAt: 3000 },
      },
    });
    await store.handleAccountDataEvent(ev);
    expect(store.getLocalAlias("a1")).toBe("Alice");
    expect(store.getLocalAlias("a2")).toBe("Bob");
    expect(store.getLocalAlias("a3")).toBe("Carol");
  });

  it("no-ops on event with missing content", async () => {
    store.localAliases["addr1"] = "Existing";
    const ev = {
      getType: () => "m.bastyon.contact_aliases",
      getContent: () => null,
    };
    await store.handleAccountDataEvent(ev);
    expect(store.getLocalAlias("addr1")).toBe("Existing");
  });
});
