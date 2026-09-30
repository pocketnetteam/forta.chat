import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

import { makeUser, type TestUser } from "@/entities/matrix/model/__tests__/pcrypto-harness";
import type { WorkerRequest, WorkerResponse } from "./crypto.worker";

/**
 * Behavioural tests for the crypto worker's derived-key cache, driving the
 * real worker module through `self.onmessage` with real secp256k1 keys.
 *
 * 1. Per-account cache: the cache key used to be `block|userIds` — no myId.
 *    After a logout / account switch in the same tab (no reload), the second
 *    account received the FIRST account's key map ({peer: K} instead of
 *    {us: K}) and failed every decrypt with `emptykey`, forever.
 * 2. Decrypt failures evict the entry (schema v19 aeskeys incident): a wrong
 *    cached key must not fail every retry identically.
 */

/** Omit that distributes over the request union. */
type RequestBody = WorkerRequest extends infer R ? (R extends WorkerRequest ? Omit<R, "id"> : never) : never;

type Handler = (e: MessageEvent<WorkerRequest>) => Promise<void>;

let handler: Handler;
const posted: WorkerResponse[] = [];
let nextId = 1;

beforeAll(async () => {
  vi.spyOn(self, "postMessage").mockImplementation(((msg: WorkerResponse) => {
    posted.push(msg);
  }) as typeof self.postMessage);
  await import("./crypto.worker");
  handler = self.onmessage as unknown as Handler;
});

beforeEach(() => {
  posted.length = 0;
});

async function call(msg: RequestBody): Promise<WorkerResponse> {
  const id = nextId++;
  await handler({ data: { ...msg, id } as WorkerRequest } as MessageEvent<WorkerRequest>);
  const res = posted.find((p) => p.id === id);
  if (!res) throw new Error("no response for " + id);
  return res;
}

const hex = (u: TestUser) => u.privates.map((p) => p.toString("hex"));
const pub = (u: TestUser) => ({ id: u.id, keys: u.publics });

describe("crypto.worker key cache", () => {
  it("serves each account its own derived keys for the same users + block", async () => {
    const alice = makeUser("aaaa11", 1);
    const bob = makeUser("bbbb22", 2);
    const users = [pub(alice), pub(bob)];
    const block = 777;

    // Account A encrypts to B — this fills the cache for (users, block).
    const enc = await call({
      type: "encrypt", users, myId: alice.id, privateKeys: hex(alice),
      targetUserId: bob.id, text: "hi bob", time: 0, block,
    });
    expect(enc.error).toBeUndefined();

    // Same worker, now account B (logout + login without reload).
    const dec = await call({
      type: "decrypt", users, myId: bob.id, privateKeys: hex(bob),
      targetUserId: alice.id, encData: enc.result as { encrypted: string; nonce: string },
      time: 0, block,
    });
    expect(dec.error).toBeUndefined();
    expect(dec.result).toBe("hi bob");
  });

  it("re-derives after a peer re-publishes keys under the same id", async () => {
    const alice = makeUser("aaaa33", 1);
    const bobOld = makeUser("bbbb44", 2);
    const bobNew = makeUser("bbbb44", 2);
    const block = 778;

    const warm = await call({
      type: "encrypt", users: [pub(alice), pub(bobOld)], myId: alice.id, privateKeys: hex(alice),
      targetUserId: bobOld.id, text: "old", time: 0, block,
    });
    expect(warm.error).toBeUndefined();

    const enc = await call({
      type: "encrypt", users: [pub(alice), pub(bobNew)], myId: alice.id, privateKeys: hex(alice),
      targetUserId: bobNew.id, text: "new keys", time: 0, block,
    });
    const dec = await call({
      type: "decrypt", users: [pub(alice), pub(bobNew)], myId: bobNew.id, privateKeys: hex(bobNew),
      targetUserId: alice.id, encData: enc.result as { encrypted: string; nonce: string }, time: 0, block,
    });
    expect(dec.result).toBe("new keys");
  });

  it("reports a decrypt failure (and evicts) instead of resolving", async () => {
    const alice = makeUser("aaaa55", 1);
    const bob = makeUser("bbbb66", 2);
    const users = [pub(alice), pub(bob)];

    const res = await call({
      type: "decrypt", users, myId: bob.id, privateKeys: hex(bob), targetUserId: alice.id,
      encData: { encrypted: Buffer.alloc(32, 1).toString("base64"), nonce: Buffer.alloc(32, 2).toString("base64") },
      time: 0, block: 779,
    });
    expect(res.error).toMatch(/verification/i);
  });
});

describe("crypto.worker eviction wiring", () => {
  it("evicts with the same (users, myId, block) key it caches under", async () => {
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const source = readFileSync(resolve(__dirname, "./crypto.worker.ts"), "utf-8");
    expect(source).toMatch(/const cacheKey = cacheKeyFor\(users, myId, block\)/);
    expect(source).toMatch(/keyCache\.delete\(cacheKeyFor\(users, myId, block\)\)/);
    expect(source).toMatch(/catch \(decryptErr\) \{[\s\S]*evictCachedKeys\(msg\.users, msg\.myId, msg\.block\);[\s\S]*throw decryptErr/);
  });
});
