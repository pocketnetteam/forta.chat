import { describe, it, expect, vi } from "vitest";

/**
 * WEE-101 — forwarded repost (Bastyon "share") renders as an empty card.
 *
 * Pocketnet encodes the reblogged txid as `repost.v` (golden reference:
 * pocketnet `_map.js` → `txidRepost: self.repost.v`), or ships a bare txid
 * string; the schema has no `repost.txid`. Both `loadPost` and `cachePost`
 * required `repostRaw.txid`, so `post.repost` was never populated for real
 * reposts and the nested PostCard never rendered.
 */

vi.mock("@/shared/lib/pocketnet", () => ({
  configurePocketnetNodes: vi.fn(),
  buildNodeBaseUrls: vi.fn(() => []),
  callPocketnetRpc: vi.fn(),
  unwrapRpcPayload: (envelope: { data?: unknown; result?: unknown }) =>
    envelope?.data ?? envelope?.result ?? envelope,
}));

// Avoid loading the heavy Bastyon chat-scripts / SDK config in the test env.
vi.mock("../chat-scripts", () => ({
  PocketnetInstanceConfigurator: { setTimeDifference: vi.fn() },
}));
vi.mock("../chat-scripts/config/pocketnetinstance", () => ({
  PocketnetInstance: { options: { listofproxies: null } },
}));

import { createAppInitializer } from "../app-initializer";
import type { AppInitializer } from "../app-initializer";

const ORIGINAL_TXID = "a".repeat(63) + "1";
const WRAPPER_TXID = "b".repeat(63) + "2";

/** Inject a fake SDK api so loadPost takes the RPC path. */
function withRpcResponse(init: AppInitializer, response: unknown): void {
  const fakeApi = { rpc: vi.fn().mockResolvedValue(response) };
  (init as unknown as { api: typeof fakeApi }).api = fakeApi;
}

describe("loadPost — repost txid extraction (WEE-101)", () => {
  it("извлекает repost.txid из repost.v (pocketnet-формат)", async () => {
    const init = createAppInitializer();
    withRpcResponse(init, [
      {
        txid: WRAPPER_TXID,
        address: "PSharerAddr",
        repost: { v: ORIGINAL_TXID },
        msg: { m: "" },
        time: 1000,
      },
    ]);

    const post = await init.loadPost(WRAPPER_TXID);

    expect(post?.repost?.txid).toBe(ORIGINAL_TXID);
  });

  it("извлекает repost из голой txid-строки", async () => {
    const init = createAppInitializer();
    withRpcResponse(init, [
      { txid: WRAPPER_TXID, repost: ORIGINAL_TXID, msg: { m: "" } },
    ]);

    const post = await init.loadPost(WRAPPER_TXID);

    expect(post?.repost?.txid).toBe(ORIGINAL_TXID);
  });

  it("не кэширует пустую заглушку {v: txid} под txid оригинала — nested PostCard должен догрузить полный пост", async () => {
    const init = createAppInitializer();
    withRpcResponse(init, [
      { txid: WRAPPER_TXID, repost: { v: ORIGINAL_TXID }, msg: { m: "" } },
    ]);

    await init.loadPost(WRAPPER_TXID);

    expect(init.getCachedPost(ORIGINAL_TXID)).toBeNull();
  });

  it("кэширует репост под txid оригинала, когда обёртка принесла его контент", async () => {
    const init = createAppInitializer();
    withRpcResponse(init, [
      {
        txid: WRAPPER_TXID,
        repost: { v: ORIGINAL_TXID, address: "POrigAuthor", m: "original%20text" },
        msg: { m: "" },
      },
    ]);

    const post = await init.loadPost(WRAPPER_TXID);

    expect(post?.repost?.message).toBe("original text");
    expect(init.getCachedPost(ORIGINAL_TXID)?.message).toBe("original text");
  });

  it("ставит repostUnresolved, если repost-маркер есть, но txid не извлекается", async () => {
    const init = createAppInitializer();
    withRpcResponse(init, [
      { txid: WRAPPER_TXID, repost: { broken: true }, msg: { m: "" } },
    ]);

    const post = await init.loadPost(WRAPPER_TXID);

    expect(post?.repost).toBeUndefined();
    expect(post?.repostUnresolved).toBe(true);
  });

  it("регрессия: обычный пост без repost рендерится как раньше", async () => {
    const init = createAppInitializer();
    withRpcResponse(init, [
      { txid: WRAPPER_TXID, address: "PAuthor", msg: { m: "hello", c: "cap" }, time: 5 },
    ]);

    const post = await init.loadPost(WRAPPER_TXID);

    expect(post?.message).toBe("hello");
    expect(post?.repost).toBeUndefined();
    expect(post?.repostUnresolved).toBeUndefined();
  });
});

describe("cachePost — repost txid extraction (WEE-101, канальная лента)", () => {
  it("извлекает repost.txid из repost.v", () => {
    const init = createAppInitializer();

    init.cachePost({
      txid: WRAPPER_TXID,
      address: "PSharerAddr",
      repost: { v: ORIGINAL_TXID },
      time: 1000,
    });

    expect(init.getCachedPost(WRAPPER_TXID)?.repost?.txid).toBe(ORIGINAL_TXID);
  });

  it("извлекает repost из голой txid-строки", () => {
    const init = createAppInitializer();

    init.cachePost({ txid: WRAPPER_TXID, repost: ORIGINAL_TXID });

    expect(init.getCachedPost(WRAPPER_TXID)?.repost?.txid).toBe(ORIGINAL_TXID);
  });

  it("не кэширует пустую заглушку под txid оригинала", () => {
    const init = createAppInitializer();

    init.cachePost({ txid: WRAPPER_TXID, repost: { v: ORIGINAL_TXID } });

    expect(init.getCachedPost(ORIGINAL_TXID)).toBeNull();
  });
});
