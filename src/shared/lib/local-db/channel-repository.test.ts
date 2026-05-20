import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { ChannelRepository } from "./channel-repository";
import type { LocalChannel } from "./schema";

class TestDb extends Dexie {
  channels!: import("dexie").Table<LocalChannel, string>;
  constructor() {
    super("test-channel-repo", { indexedDB, IDBKeyRange });
    this.version(1).stores({
      channels: "address, syncOrder, updatedAt",
    });
  }
}

function makeChannel(over: Partial<LocalChannel> = {}): LocalChannel {
  return {
    address: over.address ?? "addr_default",
    name: over.name ?? "Default",
    avatar: over.avatar ?? "",
    lastContent: over.lastContent ?? null,
    syncOrder: over.syncOrder ?? 0,
    updatedAt: over.updatedAt ?? Date.now(),
  };
}

describe("ChannelRepository", () => {
  let db: TestDb;
  let repo: ChannelRepository;

  beforeEach(() => {
    db = new TestDb();
    repo = new ChannelRepository(db as never);
  });

  afterEach(async () => {
    await db.delete();
  });

  it("returns persisted channels in syncOrder", async () => {
    await db.channels.bulkPut([
      makeChannel({ address: "c", name: "C", syncOrder: 2 }),
      makeChannel({ address: "a", name: "A", syncOrder: 0 }),
      makeChannel({ address: "b", name: "B", syncOrder: 1 }),
    ]);

    const result = await repo.getAll();

    expect(result.map((c) => c.address)).toEqual(["a", "b", "c"]);
  });

  it("returns an empty array when no channels are persisted", async () => {
    const result = await repo.getAll();
    expect(result).toEqual([]);
  });

  it("replaceAll wipes the previous set before inserting (drops unsubscribed)", async () => {
    await db.channels.bulkPut([
      makeChannel({ address: "old1", name: "Old1", syncOrder: 0 }),
      makeChannel({ address: "old2", name: "Old2", syncOrder: 1 }),
    ]);

    await repo.replaceAll([
      makeChannel({ address: "new1", name: "New1", syncOrder: 0 }),
    ]);

    const result = await repo.getAll();
    expect(result.map((c) => c.address)).toEqual(["new1"]);
  });

  it("replaceAll with empty array clears the table", async () => {
    await db.channels.bulkPut([makeChannel({ address: "old1", syncOrder: 0 })]);

    await repo.replaceAll([]);

    expect(await repo.getAll()).toEqual([]);
  });

  it("bulkUpsert appends new entries and updates existing ones in-place", async () => {
    await db.channels.bulkPut([
      makeChannel({ address: "a", name: "A", syncOrder: 0 }),
      makeChannel({ address: "b", name: "B", syncOrder: 1 }),
    ]);

    await repo.bulkUpsert([
      makeChannel({ address: "b", name: "B-renamed", syncOrder: 1 }),
      makeChannel({ address: "c", name: "C", syncOrder: 2 }),
    ]);

    const result = await repo.getAll();
    expect(result.map((c) => `${c.address}:${c.name}`)).toEqual([
      "a:A",
      "b:B-renamed",
      "c:C",
    ]);
  });

  it("bulkUpsert with an empty array is a no-op", async () => {
    await db.channels.bulkPut([makeChannel({ address: "a", syncOrder: 0 })]);
    await repo.bulkUpsert([]);
    expect((await repo.getAll()).map((c) => c.address)).toEqual(["a"]);
  });

  it("clear removes every persisted channel", async () => {
    await db.channels.bulkPut([
      makeChannel({ address: "a", syncOrder: 0 }),
      makeChannel({ address: "b", syncOrder: 1 }),
    ]);

    await repo.clear();

    expect(await repo.getAll()).toEqual([]);
  });

  it("preserves the full last-content payload for cold-start rehydration", async () => {
    await repo.replaceAll([
      makeChannel({
        address: "a",
        name: "A",
        avatar: "https://example.test/avatar.png",
        lastContent: {
          txid: "tx-1",
          type: "share",
          caption: "Hello",
          message: "World",
          time: 1700000000,
          height: 5000000,
          scoreSum: 12,
          scoreCnt: 4,
          comments: 3,
          images: ["img1"],
          url: "https://example.test",
          tags: ["news"],
          settings: { v: "a" },
        },
        syncOrder: 0,
      }),
    ]);

    const [stored] = await repo.getAll();
    expect(stored.lastContent).toEqual({
      txid: "tx-1",
      type: "share",
      caption: "Hello",
      message: "World",
      time: 1700000000,
      height: 5000000,
      scoreSum: 12,
      scoreCnt: 4,
      comments: 3,
      images: ["img1"],
      url: "https://example.test",
      tags: ["news"],
      settings: { v: "a" },
    });
    expect(stored.avatar).toBe("https://example.test/avatar.png");
  });
});
