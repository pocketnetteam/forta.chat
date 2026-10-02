import { describe, it, expect, vi } from "vitest";
import { hexEncode } from "@/shared/lib/matrix/functions";
import { resolveCryptoUsersInfo, type CryptoUsersInfoDeps, type SelfCryptoIdentity } from "../crypto-users-info";

const ME = "PR7srzZt4EfcNb3s27grgmiG8aB9vYNV82";
const PEER = "PQ8AiCHJaTZAThr2TnpkQYDyVd1Hidq4PM";
const keys = (p: string) => Array.from({ length: 12 }, (_, i) => `${p}${i}`);

const sdkUser = (address: string, id: number, k: string[]) => ({ address, id, name: address.slice(0, 4), keys: k });

function setup(opts: {
  memory?: Record<string, ReturnType<typeof sdkUser>>;
  cached?: SelfCryptoIdentity | null;
  load?: CryptoUsersInfoDeps["loadUsersInfo"];
}) {
  const memory = { ...(opts.memory ?? {}) };
  const deps: CryptoUsersInfoDeps = {
    selfAddress: ME,
    requiredKeys: 12,
    loadUsersInfo: vi.fn(opts.load ?? (async () => {})),
    getUserData: (a) => memory[a] ?? null,
    readSelfIdentity: () => opts.cached ?? null,
    writeSelfIdentity: vi.fn(),
  };
  return { deps, memory };
}

const ids = [hexEncode(ME), hexEncode(PEER)];

describe("resolveCryptoUsersInfo", () => {
  it("regression: own profile request hangs → own keys come from the cache, the room still gets keys", async () => {
    // The SDK's own-profile request never settles; any load that includes
    // the own address would hang with it.
    const { deps } = setup({
      memory: { [PEER]: sdkUser(PEER, 45, keys("p")) },
      cached: { keys: keys("m"), id: 29561667 },
      load: async (addrs) => { if (addrs.includes(ME)) await new Promise(() => {}); },
    });

    const res = await resolveCryptoUsersInfo(ids, undefined, deps);

    // The peer is in SDK memory and the own keys in the cache — no SDK call at all.
    expect(deps.loadUsersInfo).not.toHaveBeenCalled();
    expect(res[0]).toMatchObject({ id: ids[0], keys: keys("m"), source: { id: 29561667 } });
    expect(res[1]).toMatchObject({ id: ids[1], keys: keys("p"), source: { id: 45 } });
  });

  it("prefers own keys from SDK memory and refreshes the cache with them", async () => {
    const { deps } = setup({
      memory: { [ME]: sdkUser(ME, 29561667, keys("fresh")), [PEER]: sdkUser(PEER, 45, keys("p")) },
      cached: { keys: keys("old"), id: 29561667 },
    });

    const res = await resolveCryptoUsersInfo(ids, undefined, deps);

    expect(deps.loadUsersInfo).not.toHaveBeenCalled();
    expect(res[0].keys).toEqual(keys("fresh"));
    expect(deps.writeSelfIdentity).toHaveBeenCalledWith({ keys: keys("fresh"), id: 29561667, name: "PR7s" });
  });

  it("loads the own profile through the SDK when neither memory nor cache has keys", async () => {
    const { deps, memory } = setup({
      cached: null,
      load: async (addrs) => {
        for (const a of addrs) memory[a] = sdkUser(a, a === ME ? 1 : 2, keys(a.slice(0, 2)));
      },
    });

    const res = await resolveCryptoUsersInfo(ids, undefined, deps);

    expect(deps.loadUsersInfo).toHaveBeenCalledWith([ME, PEER], { update: false });
    expect(res[0].keys).toHaveLength(12);
    expect(deps.writeSelfIdentity).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it("asks the SDK only for participants missing from its memory", async () => {
    const { deps } = setup({ memory: { [ME]: sdkUser(ME, 1, keys("m")) } });
    await resolveCryptoUsersInfo(ids, undefined, deps);
    expect(deps.loadUsersInfo).toHaveBeenCalledWith([PEER], { update: false });
  });

  it("includes the own address on an explicit forced refresh", async () => {
    const { deps } = setup({ cached: { keys: keys("m"), id: 1 } });
    await resolveCryptoUsersInfo(ids, { forceUpdate: true }, deps);
    expect(deps.loadUsersInfo).toHaveBeenCalledWith([ME, PEER], { update: true });
  });

  it("falls back to the cache when the SDK load fails for the own address", async () => {
    const { deps } = setup({
      cached: { keys: keys("m"), id: 9 },
      load: async () => { throw new Error("rpc down"); },
    });
    const res = await resolveCryptoUsersInfo(ids, { forceUpdate: true }, deps);
    expect(res[0]).toMatchObject({ keys: keys("m"), source: { id: 9 } });
    expect(res[1].keys).toEqual([]);
  });

  it("does not let an incomplete cached key set stand in for the real one", async () => {
    const { deps } = setup({ cached: { keys: keys("m").slice(0, 5), id: 9 } });
    const res = await resolveCryptoUsersInfo(ids, undefined, deps);
    expect(deps.loadUsersInfo).toHaveBeenCalledWith([ME, PEER], { update: false });
    expect(res[0].keys).toEqual([]);
  });

  it("reads keys from a comma-separated `k` when the SDK keys are empty", async () => {
    const { deps } = setup({
      memory: { [PEER]: { address: PEER, id: 45, name: "p", keys: [], k: keys("p").join(",") } as never },
      cached: { keys: keys("m"), id: 1 },
    });
    const res = await resolveCryptoUsersInfo(ids, undefined, deps);
    expect(res[1].keys).toEqual(keys("p"));
  });
});
