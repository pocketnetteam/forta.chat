import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { ChatDatabase } from "../schema";
import { UserRepository } from "../user-repository";

/**
 * Tests for the local-alias CRUD layer in UserRepository (Session 51).
 *
 * Schema v13 adds `localAlias` + `aliasUpdatedAt` to LocalUser. These tests
 * pin the CRUD shape that chat-store + the cross-device sync handler rely on:
 *
 *  - setAlias persists for both known and unknown users (creates a skeleton
 *    row if the user is not yet cached).
 *  - setAlias is last-write-wins by timestamp argument (the cross-device sync
 *    layer uses this for conflict resolution).
 *  - setAlias(null) clears alias + bumps aliasUpdatedAt (tombstone semantics).
 *  - getAllAliases returns only rows with a non-empty alias — used to
 *    hydrate chat-store.localAliases on login / cold-start.
 */

let db: ChatDatabase;
let repo: UserRepository;

beforeEach(async () => {
  const name = `test-alias-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db = new ChatDatabase(name);
  await db.open();
  repo = new UserRepository(db);
});

afterEach(async () => {
  await db.delete();
});

describe("UserRepository — alias CRUD", () => {
  it("setAlias persists for unknown user (creates skeleton row)", async () => {
    await repo.setAlias("addr1", "Alias", 1000);
    expect(await repo.getAlias("addr1")).toBe("Alias");
  });

  it("setAlias overrides previous alias", async () => {
    await repo.setAlias("addr1", "First", 1000);
    await repo.setAlias("addr1", "Second", 2000);
    expect(await repo.getAlias("addr1")).toBe("Second");
  });

  it("setAlias(null) clears alias", async () => {
    await repo.setAlias("addr1", "Alias", 1000);
    await repo.setAlias("addr1", null, 2000);
    expect(await repo.getAlias("addr1")).toBeNull();
  });

  it("setAlias preserves existing name/about/image when adding alias", async () => {
    await repo.upsertUser({
      address: "addr1",
      name: "Real Name",
      about: "Bio",
      image: "avatar.jpg",
      updatedAt: 5000,
      syncedAt: 5000,
    });
    await repo.setAlias("addr1", "Alias", 6000);
    const user = await repo.getUser("addr1");
    expect(user?.name).toBe("Real Name");
    expect(user?.about).toBe("Bio");
    expect(user?.image).toBe("avatar.jpg");
    expect(user?.localAlias).toBe("Alias");
    expect(user?.aliasUpdatedAt).toBe(6000);
  });

  it("getAliasUpdatedAt returns 0 when no alias set", async () => {
    expect(await repo.getAliasUpdatedAt("nobody")).toBe(0);
  });

  it("getAliasUpdatedAt returns stored timestamp after setAlias", async () => {
    await repo.setAlias("addr1", "Alias", 12345);
    expect(await repo.getAliasUpdatedAt("addr1")).toBe(12345);
  });

  it("getAllAliases returns only users with a localAlias", async () => {
    await repo.setAlias("a1", "A", 1000);
    await repo.upsertUser({
      address: "a2",
      name: "No alias",
      updatedAt: 0,
      syncedAt: 0,
    });
    const all = await repo.getAllAliases();
    expect(all).toHaveProperty("a1");
    expect(all.a1.alias).toBe("A");
    expect(all.a1.updatedAt).toBe(1000);
    expect(all).not.toHaveProperty("a2");
  });

  it("getAllAliases excludes cleared aliases", async () => {
    await repo.setAlias("a1", "A", 1000);
    await repo.setAlias("a1", null, 2000);
    const all = await repo.getAllAliases();
    expect(all).not.toHaveProperty("a1");
  });
});
