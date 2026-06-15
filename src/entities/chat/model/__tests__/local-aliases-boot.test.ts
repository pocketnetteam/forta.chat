import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";

/**
 * WEE-102 regression — local contact aliases must apply at cold boot and
 * fully offline.
 *
 * Root cause: `loadLocalAliases()` was only reachable inside `initMatrix()`,
 * which runs after the network steps of `login()` / the cold-boot
 * `fetchUserInfo()`. Offline, those steps stall before the alias hydration is
 * ever reached, so `localAliases` stays empty and every renamed contact shows
 * its raw nickname forever.
 *
 * Fix: `hydrateLocalAliasesEarly(rawAddress)` reads aliases straight from Dexie
 * (`readUserAliases`) with no SyncEngine / Matrix / network dependency, so the
 * cache is populated from the first frame regardless of connectivity. This file
 * pins that Dexie-only, network-independent behaviour.
 */

// Override ONLY readUserAliases; keep the rest of the local-db module real so
// chat-store's other imports (ChatDatabase, useLiveQuery, mappers) still work.
const mockReadUserAliases = vi.fn();
vi.mock("@/shared/lib/local-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/lib/local-db")>();
  return {
    ...actual,
    readUserAliases: (...args: unknown[]) => mockReadUserAliases(...args),
  };
});

import { useChatStore } from "../chat-store";
import { hexEncode } from "@/shared/lib/matrix/functions";

describe("WEE-102 — local aliases hydrate at cold boot / offline", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockReadUserAliases.mockReset();
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
  });

  it("hydrateLocalAliasesEarly populates localAliases straight from Dexie (no Matrix)", async () => {
    mockReadUserAliases.mockResolvedValue({ PMama: { alias: "Мама", updatedAt: 10 } });

    await store.hydrateLocalAliasesEarly("PaddrSelf");

    expect(mockReadUserAliases).toHaveBeenCalledWith("PaddrSelf");
    expect(store.localAliases["PMama"]).toBe("Мама");
  });

  it("getDisplayName returns the alias right after early hydration (no /sync)", async () => {
    mockReadUserAliases.mockResolvedValue({ PMama: { alias: "Мама", updatedAt: 10 } });

    // Before hydration: no alias, no profile → must NOT already be the alias.
    expect(store.getDisplayName("PMama")).not.toBe("Мама");

    await store.hydrateLocalAliasesEarly("PaddrSelf");

    expect(store.getDisplayName("PMama")).toBe("Мама");
    // Hex form (room.members shape) resolves to the same alias.
    expect(store.getDisplayName(hexEncode("PMama"))).toBe("Мама");
  });

  it("is offline-safe: a Dexie read failure resolves without throwing", async () => {
    mockReadUserAliases.mockRejectedValue(new Error("Dexie closed"));

    await expect(store.hydrateLocalAliasesEarly("PaddrSelf")).resolves.toBeUndefined();
    expect(store.localAliases).toEqual({});
  });

  it("no-ops on an empty address — never touches Dexie", async () => {
    await store.hydrateLocalAliasesEarly("");
    expect(mockReadUserAliases).not.toHaveBeenCalled();
  });

  it("loadLocalAliases reads only from Dexie via the live kit (no network)", async () => {
    const getAllAliases = vi
      .fn()
      .mockResolvedValue({ PPapa: { alias: "Папа", updatedAt: 5 } });
    store.setChatDbKit({
      users: { getAllAliases },
      rooms: {
        getAllRooms: vi.fn().mockResolvedValue([]),
        observeRoomChanges: vi.fn().mockReturnValue(() => {}),
      },
      eventWriter: { enableBatching: vi.fn() },
    } as never);

    await store.loadLocalAliases();

    expect(getAllAliases).toHaveBeenCalledTimes(1);
    expect(store.getDisplayName("PPapa")).toBe("Папа");
  });
});
