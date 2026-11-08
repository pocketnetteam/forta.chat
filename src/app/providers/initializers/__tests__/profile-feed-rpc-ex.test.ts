import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../chat-scripts", () => ({ PocketnetInstanceConfigurator: { setTimeDifference: vi.fn() } }));
vi.mock("../../chat-scripts/config/pocketnetinstance", () => ({
  PocketnetInstance: { options: { listofproxies: [{ host: "1.pocketnet.app", port: 8899 }] } },
}));

const rpc = vi.hoisted(() => ({ calls: [] as Array<{ endpoint?: string }>, handler: null as null | ((endpoint?: string) => unknown) }));
vi.mock("@/shared/lib/pocketnet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/lib/pocketnet")>();
  return {
    ...actual,
    installSdkRpcBridge: vi.fn(),
    callPocketnetRpc: async (req: { endpoint?: string }) => {
      rpc.calls.push(req);
      return rpc.handler!(req.endpoint);
    },
  };
});

const primePeerTubeSources = vi.fn();
vi.mock("@/shared/lib/video-embed", () => ({ primePeerTubeSources: (v: unknown) => primePeerTubeSources(v) }));

import { createAppInitializer } from "../app-initializer";

const POST = { txid: "a3dc", u: "peertube://peertube900.pocketnet.app/b2cde7de" };
const VIDEOS = { "peertube://peertube900.pocketnet.app/b2cde7de": { aspectRatio: 1.78 } };
const USERS = [{ address: "PPN7", name: "Dake_ST" }];

beforeEach(() => {
  rpc.calls = [];
  primePeerTubeSources.mockClear();
});

describe("getProfileFeed through rpc-ex", () => {
  it("returns the posts and the profiles, and seeds the video sources", async () => {
    rpc.handler = () => ({ data: { contents: [POST], videos: VIDEOS, users: USERS } });
    const page = await createAppInitializer().getProfileFeed("PGuP");

    expect(rpc.calls[0].endpoint).toBe("rpc-ex");
    expect(page).toEqual({ contents: [POST], users: USERS });
    expect(primePeerTubeSources).toHaveBeenCalledWith(VIDEOS);
  });

  it("falls back to plain rpc when rpc-ex fails", async () => {
    rpc.handler = (endpoint) => {
      if (endpoint === "rpc-ex") throw new Error("404");
      return { data: [POST] };
    };
    const page = await createAppInitializer().getProfileFeed("PGuP");

    expect(rpc.calls.map((c) => c.endpoint)).toEqual(["rpc-ex", "rpc"]);
    expect(page).toEqual({ contents: [POST], users: [] });
  });

  it("an empty page when every node fails", async () => {
    rpc.handler = () => { throw new Error("offline"); };
    await expect(createAppInitializer().getProfileFeed("PGuP")).resolves.toEqual({ contents: [], users: [] });
  });
});
