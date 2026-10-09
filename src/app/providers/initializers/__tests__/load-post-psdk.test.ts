import { describe, it, expect, vi } from "vitest";

/**
 * loadPost / loadTransaction go through psdk (IndexedDB + in-memory caches,
 * batched RPC, Bastyon's own cleaning) and keep the direct RPC as fallback.
 */

vi.mock("@/shared/lib/pocketnet", () => ({
  configurePocketnetNodes: vi.fn(),
  buildNodeBaseUrls: vi.fn(() => []),
  callPocketnetRpc: vi.fn(),
  unwrapRpcPayload: (envelope: { data?: unknown; result?: unknown }) =>
    envelope?.data ?? envelope?.result ?? envelope,
}));
vi.mock("../chat-scripts", () => ({
  PocketnetInstanceConfigurator: { setTimeDifference: vi.fn() },
}));
vi.mock("../chat-scripts/config/pocketnetinstance", () => ({
  PocketnetInstance: { options: { listofproxies: null } },
}));

import { createAppInitializer, shareToPostData } from "../app-initializer";
import type { AppInitializer } from "../app-initializer";

const TXID = "a".repeat(64);
const ORIGINAL = "b".repeat(64);

function share(partial: Partial<PShareSDK> = {}): PShareSDK {
  return {
    txid: TXID,
    address: "PAuthor",
    caption: "Title",
    message: "Body",
    images: ["https://img/1.jpg", "https://img/2.jpg"],
    tags: ["news"],
    url: "",
    settings: {},
    repost: "",
    time: new Date(1_700_000_000_000),
    score: 12,
    scnt: 3,
    ...partial,
  };
}

function inject(init: AppInitializer, parts: { psdk?: unknown; api?: unknown }) {
  Object.assign(init as unknown as Record<string, unknown>, parts);
}

describe("shareToPostData", () => {
  it("maps a pShare to post data", () => {
    expect(shareToPostData(share())).toEqual({
      txid: TXID,
      address: "PAuthor",
      caption: "Title",
      message: "Body",
      images: ["https://img/1.jpg", "https://img/2.jpg"],
      url: "",
      tags: ["news"],
      settings: {},
      time: 1_700_000_000,
      scoreSum: 12,
      scoreCnt: 3,
      myVal: undefined,
    });
  });

  it("an article v2 message (parsed Editor.js object) is passed on as JSON text", () => {
    const blocks = { blocks: [{ type: "paragraph", data: { text: "hi" } }] };
    const post = shareToPostData(share({ settings: { v: "a", version: 2 }, message: blocks }));
    expect(JSON.parse(post.message)).toEqual(blocks);
  });

  it("a repost keeps only the original's txid; an unparsable marker flags it unresolved", () => {
    expect(shareToPostData(share({ repost: ORIGINAL })).repost?.txid).toBe(ORIGINAL);
    expect(shareToPostData(share({ repost: { v: ORIGINAL } })).repost?.txid).toBe(ORIGINAL);
    const broken = shareToPostData(share({ repost: { x: 1 } }));
    expect(broken.repost).toBeUndefined();
    expect(broken.repostUnresolved).toBe(true);
  });
});

describe("loadPost via psdk", () => {
  it("loads through psdk.share and caches the result — no direct RPC", async () => {
    const init = createAppInitializer();
    const psdk = { share: { load: vi.fn().mockResolvedValue(undefined), get: vi.fn(() => share()) } };
    const api = { rpc: vi.fn() };
    inject(init, { psdk, api });

    const post = await init.loadPost(TXID);
    expect(post?.caption).toBe("Title");
    expect(psdk.share.load).toHaveBeenCalledWith([TXID]);
    expect(api.rpc).not.toHaveBeenCalled();

    await init.loadPost(TXID);
    expect(psdk.share.load).toHaveBeenCalledTimes(1);
    expect(init.getCachedPost(TXID)?.caption).toBe("Title");
  });

  it("a deleted or unknown post is null", async () => {
    const init = createAppInitializer();
    inject(init, { psdk: { share: { load: vi.fn().mockResolvedValue(undefined), get: () => share({ deleted: true }) } } });
    expect(await init.loadPost(TXID)).toBeNull();
  });

  it("falls back to the direct RPC when psdk fails", async () => {
    const init = createAppInitializer();
    const api = { rpc: vi.fn().mockResolvedValue([{ txid: TXID, address: "PAuthor", c: "From RPC", m: "" }]) };
    inject(init, { psdk: { share: { load: vi.fn().mockRejectedValue(new Error("idb")), get: vi.fn() } }, api });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect((await init.loadPost(TXID))?.caption).toBe("From RPC");
    expect(api.rpc).toHaveBeenCalledWith("getrawtransactionwithmessagebyid", [[TXID]]);
  });
});

describe("loadTransaction via psdk", () => {
  it("delegates to psdk.transaction.load with the update flag", async () => {
    const init = createAppInitializer();
    const tx = { txid: TXID, height: 1, blockHash: "h" };
    const psdk = { transaction: { load: vi.fn().mockResolvedValue(tx) } };
    inject(init, { psdk });

    expect(await init.loadTransaction(TXID)).toBe(tx);
    await init.loadTransaction(TXID, true);
    expect(psdk.transaction.load.mock.calls).toEqual([[TXID, false], [TXID, true]]);
  });
});
