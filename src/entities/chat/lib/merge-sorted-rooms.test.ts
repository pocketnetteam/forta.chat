import { describe, expect, it } from "vitest";
import { mergeIntoSortedRooms } from "./merge-sorted-rooms";

interface R { id: string; ts: number }

const key = (r: R) => r.ts;
const room = (id: string, ts: number): R => ({ id, ts });
const ids = (rooms: R[] | null) => rooms?.map((r) => r.id) ?? null;

/** The previous per-change algorithm: findIndex + splice + binary-search insert. */
function patchOneByOne(sorted: R[], updates: Map<string, R | null>, pinned: Set<string>): R[] | null {
  const arr = [...sorted];
  let mutated = false;
  for (const [id, next] of updates) {
    const oldIdx = arr.findIndex((r) => r.id === id);
    if (!next) {
      if (oldIdx !== -1) { arr.splice(oldIdx, 1); mutated = true; }
      continue;
    }
    if (oldIdx !== -1 && arr[oldIdx] === next) continue;
    if (oldIdx !== -1) arr.splice(oldIdx, 1);
    const isPinned = pinned.has(id);
    let lo = 0;
    let hi = 0;
    if (isPinned) {
      while (hi < arr.length && pinned.has(arr[hi].id)) hi++;
    } else {
      while (lo < arr.length && pinned.has(arr[lo].id)) lo++;
      hi = arr.length;
    }
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (key(arr[mid]) > next.ts) lo = mid + 1;
      else hi = mid;
    }
    arr.splice(lo, 0, next);
    mutated = true;
  }
  return mutated ? arr : null;
}

describe("mergeIntoSortedRooms", () => {
  const base = [room("a", 50), room("b", 40), room("c", 30), room("d", 20)];

  it("returns null for an empty batch", () => {
    expect(mergeIntoSortedRooms(base, new Map(), key, new Set())).toBeNull();
  });

  it("returns null when every update is the same reference", () => {
    const updates = new Map<string, R | null>([["b", base[1]], ["c", base[2]]]);
    expect(mergeIntoSortedRooms(base, updates, key, new Set())).toBeNull();
  });

  it("returns null when removing a room that is not in the list", () => {
    expect(mergeIntoSortedRooms(base, new Map([["zz", null]]), key, new Set())).toBeNull();
  });

  it("moves a room with a new message to the top", () => {
    const updates = new Map<string, R | null>([["c", room("c", 99)]]);
    expect(ids(mergeIntoSortedRooms(base, updates, key, new Set()))).toEqual(["c", "a", "b", "d"]);
  });

  it("removes deleted rooms and inserts new ones", () => {
    const updates = new Map<string, R | null>([["b", null], ["e", room("e", 25)]]);
    expect(ids(mergeIntoSortedRooms(base, updates, key, new Set()))).toEqual(["a", "c", "e", "d"]);
  });

  it("keeps pinned rooms first", () => {
    const sorted = [room("p", 10), room("a", 50), room("b", 40)];
    const pinned = new Set(["p", "q"]);
    const updates = new Map<string, R | null>([["q", room("q", 5)], ["c", room("c", 100)]]);
    expect(ids(mergeIntoSortedRooms(sorted, updates, key, pinned))).toEqual(["p", "q", "c", "a", "b"]);
  });

  it("inserts before existing rooms with an equal key", () => {
    const updates = new Map<string, R | null>([["e", room("e", 40)]]);
    expect(ids(mergeIntoSortedRooms(base, updates, key, new Set()))).toEqual(["a", "e", "b", "c", "d"]);
  });

  it("does not mutate the input list", () => {
    const sorted = [...base];
    mergeIntoSortedRooms(sorted, new Map([["a", null]]), key, new Set());
    expect(sorted).toEqual(base);
  });

  it("matches one-by-one insertion on random batches", () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let run = 0; run < 300; run++) {
      const pinned = new Set<string>();
      const all: R[] = [];
      for (let i = 0; i < 40; i++) {
        const r = room(`r${i}`, rand(15));
        all.push(r);
        if (rand(6) === 0) pinned.add(r.id);
      }
      const sorted = all
        .filter(() => rand(4) !== 0)
        .sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)) || b.ts - a.ts);
      const updates = new Map<string, R | null>();
      const batch = 1 + rand(25);
      for (let i = 0; i < batch; i++) {
        const id = `r${rand(45)}`;
        const kind = rand(4);
        const current = sorted.find((r) => r.id === id);
        if (kind === 0) updates.set(id, null);
        else if (kind === 1 && current) updates.set(id, current);
        else updates.set(id, room(id, rand(15)));
      }
      expect(ids(mergeIntoSortedRooms(sorted, updates, key, pinned))).toEqual(ids(patchOneByOne(sorted, updates, pinned)));
    }
  });
});
