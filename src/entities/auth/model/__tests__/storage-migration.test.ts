import { describe, it, expect, beforeEach } from "vitest";
import {
  migratePerAccountKeys,
  migrateAll,
  purgeEmptyUserStoreProfiles,
  purgeEmptyProfilesOnce,
} from "../storage-migration";

const SESSIONS_KEY = "forta-chat:sessions";
const ACTIVE_KEY = "forta-chat:activeAccount";
const EMPTY_PROFILE_PURGE_FLAG = "forta-chat:empty-profile-purge-v1";

describe("storage-migration", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("migratePerAccountKeys", () => {
    it("moves chat_pinned_rooms to per-account key", () => {
      localStorage.setItem("chat_pinned_rooms", JSON.stringify(["!room1", "!room2"]));

      migratePerAccountKeys("addr1");

      expect(localStorage.getItem("chat_pinned_rooms")).toBeNull();
      expect(JSON.parse(localStorage.getItem("chat_pinned_rooms:addr1")!)).toEqual(["!room1", "!room2"]);
    });

    it("moves chat_muted_rooms to per-account key", () => {
      localStorage.setItem("chat_muted_rooms", JSON.stringify(["!roomA"]));

      migratePerAccountKeys("addr1");

      expect(localStorage.getItem("chat_muted_rooms")).toBeNull();
      expect(JSON.parse(localStorage.getItem("chat_muted_rooms:addr1")!)).toEqual(["!roomA"]);
    });

    it("skips if per-account key already exists", () => {
      localStorage.setItem("chat_pinned_rooms", JSON.stringify(["!old"]));
      localStorage.setItem("chat_pinned_rooms:addr1", JSON.stringify(["!existing"]));
      localStorage.setItem("chat_muted_rooms", JSON.stringify(["!oldMuted"]));
      localStorage.setItem("chat_muted_rooms:addr1", JSON.stringify(["!existingMuted"]));

      migratePerAccountKeys("addr1");

      // Per-account keys should remain unchanged
      expect(JSON.parse(localStorage.getItem("chat_pinned_rooms:addr1")!)).toEqual(["!existing"]);
      expect(JSON.parse(localStorage.getItem("chat_muted_rooms:addr1")!)).toEqual(["!existingMuted"]);
      // Old keys should still be there (not removed since per-account existed)
      expect(localStorage.getItem("chat_pinned_rooms")).not.toBeNull();
      expect(localStorage.getItem("chat_muted_rooms")).not.toBeNull();
    });

    it("does nothing when no old keys exist", () => {
      migratePerAccountKeys("addr1");

      expect(localStorage.getItem("chat_pinned_rooms:addr1")).toBeNull();
      expect(localStorage.getItem("chat_muted_rooms:addr1")).toBeNull();
    });

    it("migrates pinned but not muted when only pinned exists", () => {
      localStorage.setItem("chat_pinned_rooms", JSON.stringify(["!room1"]));

      migratePerAccountKeys("addr1");

      expect(JSON.parse(localStorage.getItem("chat_pinned_rooms:addr1")!)).toEqual(["!room1"]);
      expect(localStorage.getItem("chat_muted_rooms:addr1")).toBeNull();
    });
  });

  describe("purgeEmptyUserStoreProfiles", () => {
    it("removes empty-name entries and keeps named ones", () => {
      localStorage.setItem(
        "bastyon-chat-users",
        JSON.stringify({
          Pempty: { address: "Pempty", name: "", about: "" },
          Palice: { address: "Palice", name: "Alice", about: "" },
          Pblank: { address: "Pblank", name: "   ", about: "" },
        }),
      );

      expect(purgeEmptyUserStoreProfiles()).toBe(2);
      const kept = JSON.parse(localStorage.getItem("bastyon-chat-users")!);
      expect(Object.keys(kept)).toEqual(["Palice"]);
      expect(kept.Palice.name).toBe("Alice");
    });

    it("is a no-op when the cache is already clean", () => {
      localStorage.setItem(
        "bastyon-chat-users",
        JSON.stringify({ Palice: { address: "Palice", name: "Alice" } }),
      );
      expect(purgeEmptyUserStoreProfiles()).toBe(0);
    });
  });

  describe("purgeEmptyProfilesOnce", () => {
    it("runs once then skips on subsequent calls", () => {
      localStorage.setItem(
        "bastyon-chat-users",
        JSON.stringify({ Pempty: { address: "Pempty", name: "" } }),
      );

      purgeEmptyProfilesOnce();
      expect(localStorage.getItem(EMPTY_PROFILE_PURGE_FLAG)).toBe("1");
      expect(JSON.parse(localStorage.getItem("bastyon-chat-users")!)).toEqual({});

      // Re-poison and ensure flag prevents a second purge
      localStorage.setItem(
        "bastyon-chat-users",
        JSON.stringify({ Pempty: { address: "Pempty", name: "" } }),
      );
      purgeEmptyProfilesOnce();
      expect(JSON.parse(localStorage.getItem("bastyon-chat-users")!).Pempty.name).toBe("");
    });
  });

  describe("migrateAll", () => {
    it("runs SessionManager.migrate() and migratePerAccountKeys for active address", () => {
      // Set up old singleton auth
      localStorage.setItem(
        "forta-chat:auth",
        JSON.stringify({ address: "addr1", privateKey: "pk1" }),
      );
      localStorage.setItem("chat_pinned_rooms", JSON.stringify(["!room1"]));
      localStorage.setItem("chat_muted_rooms", JSON.stringify(["!roomA"]));

      migrateAll();

      // SessionManager.migrate() should have converted auth
      expect(localStorage.getItem("forta-chat:auth")).toBeNull();
      const sessions = JSON.parse(localStorage.getItem(SESSIONS_KEY)!);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].address).toBe("addr1");

      // Per-account keys should have been migrated
      expect(JSON.parse(localStorage.getItem("chat_pinned_rooms:addr1")!)).toEqual(["!room1"]);
      expect(JSON.parse(localStorage.getItem("chat_muted_rooms:addr1")!)).toEqual(["!roomA"]);
    });

    it("skips per-account migration when no active address", () => {
      // No auth data at all
      localStorage.setItem("chat_pinned_rooms", JSON.stringify(["!room1"]));

      migrateAll();

      // Global key should remain (no active address to migrate to)
      expect(localStorage.getItem("chat_pinned_rooms")).not.toBeNull();
    });

    it("works when sessions already exist (no singleton to migrate)", () => {
      const sessions = [{ address: "addr1", privateKey: "pk1", addedAt: 1000 }];
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
      localStorage.setItem(ACTIVE_KEY, JSON.stringify("addr1"));
      localStorage.setItem("chat_pinned_rooms", JSON.stringify(["!room1"]));

      migrateAll();

      // Per-account key should be created from global
      expect(JSON.parse(localStorage.getItem("chat_pinned_rooms:addr1")!)).toEqual(["!room1"]);
      expect(localStorage.getItem("chat_pinned_rooms")).toBeNull();
    });

    it("purges empty user-store profiles on boot", () => {
      localStorage.setItem(
        "bastyon-chat-users",
        JSON.stringify({ Pempty: { address: "Pempty", name: "" } }),
      );
      migrateAll();
      expect(JSON.parse(localStorage.getItem("bastyon-chat-users")!)).toEqual({});
      expect(localStorage.getItem(EMPTY_PROFILE_PURGE_FLAG)).toBe("1");
    });
  });
});
