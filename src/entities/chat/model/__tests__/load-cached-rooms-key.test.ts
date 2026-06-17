import { describe, it, expect, beforeEach } from "vitest";
import { resolveCachedRoomsAddress } from "../cached-rooms-address";

const ACTIVE_KEY = "forta-chat:activeAccount";
const LEGACY_KEY = "forta-chat:auth";

describe("resolveCachedRoomsAddress (WEE-61 / forta-bugs#892)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("reads forta-chat:activeAccount, not the migration-removed forta-chat:auth", () => {
    // Post-migration state: legacy key gone, address under activeAccount.
    localStorage.removeItem(LEGACY_KEY);
    localStorage.setItem(ACTIVE_KEY, JSON.stringify("addr1"));

    expect(resolveCachedRoomsAddress()).toBe("addr1");
  });

  it("falls back to legacy forta-chat:auth when activeAccount is absent (pre-migration)", () => {
    // loadCachedRooms can run before SessionManager.migrate() — still resolve.
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ address: "legacyAddr", privateKey: "pk" }));

    expect(resolveCachedRoomsAddress()).toBe("legacyAddr");
  });

  it("prefers activeAccount over legacy when both exist", () => {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify("activeAddr"));
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ address: "legacyAddr", privateKey: "pk" }));

    expect(resolveCachedRoomsAddress()).toBe("activeAddr");
  });

  it("returns null when nothing is stored", () => {
    expect(resolveCachedRoomsAddress()).toBeNull();
  });

  it("returns null on malformed activeAccount with no legacy fallback", () => {
    localStorage.setItem(ACTIVE_KEY, "{not-json");

    expect(resolveCachedRoomsAddress()).toBeNull();
  });

  it("ignores a null-address legacy payload", () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ address: null, privateKey: "pk" }));

    expect(resolveCachedRoomsAddress()).toBeNull();
  });
});
