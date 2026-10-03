import { describe, it, expect, vi } from "vitest";

/**
 * Shared comment links (`…?s={post}&commentid={id}`) preview the comment
 * itself. Bastyon loads it by id — psdk.comment.load:
 * getcomments(['', '', address, ids]) — and trydecodes the msg JSON fields.
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

import { createAppInitializer, parseCommentsResponse } from "../app-initializer";
import type { AppInitializer } from "../app-initializer";

const COMMENT = "c".repeat(64);
const POST = "a".repeat(64);

function withRpc(init: AppInitializer, response: unknown) {
  const rpc = vi.fn().mockResolvedValue(response);
  (init as unknown as { api: { rpc: typeof rpc } }).api = { rpc };
  return rpc;
}

describe("loadCommentsByIds", () => {
  it("requests comments by id in Bastyon's bulk format", async () => {
    const init = createAppInitializer();
    const rpc = withRpc(init, [{
      id: COMMENT, postid: POST, parentid: "", answerid: "", address: "addr", time: "1700000000",
      msg: JSON.stringify({ message: encodeURIComponent("Привет, мир"), url: "", images: [encodeURIComponent("https://i.imgur.com/x.jpg")], info: "" }),
    }]);

    const list = await init.loadCommentsByIds([COMMENT], "me");

    expect(rpc).toHaveBeenCalledWith("getcomments", ["", "", "me", [COMMENT]]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: COMMENT, postid: POST, address: "addr", message: "Привет, мир",
      images: ["https://i.imgur.com/x.jpg"], time: 1_700_000_000,
    });
    expect(list[0].deleted).toBeUndefined();
  });

  it("returns [] without ids or when the RPC fails", async () => {
    const init = createAppInitializer();
    const rpc = withRpc(init, []);
    expect(await init.loadCommentsByIds([])).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();

    rpc.mockRejectedValueOnce(new Error("node down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await init.loadCommentsByIds([COMMENT])).toEqual([]);
  });
});

describe("parseCommentsResponse", () => {
  it("flags deleted comments and unwraps {data: []}", () => {
    const [c] = parseCommentsResponse({ data: [{ id: COMMENT, deleted: true, address: "a" }] }, POST);
    expect(c).toMatchObject({ id: COMMENT, postid: POST, message: "", deleted: true });
  });

  it("keeps a malformed % sequence as is and skips non-objects", () => {
    const list = parseCommentsResponse([null, { id: COMMENT, msg: JSON.stringify({ message: "100% sure" }) }], POST);
    expect(list).toHaveLength(1);
    expect(list[0].message).toBe("100% sure");
  });
});
