import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/** AppInitializer pieces of account deletion: accDel broadcast, balance, PeerTube host list. */

vi.mock("../../chat-scripts", () => ({
  PocketnetInstanceConfigurator: { setTimeDifference: vi.fn() },
}));
vi.mock("../../chat-scripts/config/pocketnetinstance", () => ({
  PocketnetInstance: { options: { listofproxies: [{ host: "1.pocketnet.app", port: 8899 }] } },
}));
vi.mock("@/shared/lib/pocketnet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/lib/pocketnet")>();
  return { ...actual, installSdkRpcBridge: vi.fn() };
});

import { createAppInitializer } from "../app-initializer";

class FakeDeleteAccount {
  type = "accDel";
}

function withFakes() {
  const init = createAppInitializer();
  const account = {
    updateUnspents: vi.fn(async () => {}),
    actualBalance: vi.fn(() => ({ actual: 2.5 })),
  };
  const actions = {
    addActionAndSendIfCan: vi.fn(async () => ({ transaction: "tx1" })),
    getCurrentAccount: vi.fn(() => account),
  };
  const api = {
    initIf: vi.fn(async () => {}),
    fetch: vi.fn(async () => ({ "0": ["a.example", "arch.example"], "1": ["b.example", "arch.example"] })),
  };
  Object.assign(init as unknown as Record<string, unknown>, { actions, api, _available: true });
  return { init, actions, account, api };
}

describe("AppInitializer — account deletion", () => {
  beforeEach(() => {
    vi.stubGlobal("DeleteAccount", FakeDeleteAccount);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("broadcasts an accDel transaction for the address", async () => {
    const { init, actions } = withFakes();
    await expect(init.deleteAccountOnChain("PAddr")).resolves.toEqual({ transaction: "tx1" });
    const [info, arg, address] = actions.addActionAndSendIfCan.mock.calls[0] as unknown as [FakeDeleteAccount, null, string];
    expect(info).toBeInstanceOf(FakeDeleteAccount);
    expect(arg).toBeNull();
    expect(address).toBe("PAddr");
  });

  it("propagates a rejected transaction", async () => {
    const { init, actions } = withFakes();
    actions.addActionAndSendIfCan.mockRejectedValueOnce(new Error("rejected"));
    await expect(init.deleteAccountOnChain("PAddr")).rejects.toThrow("rejected");
  });

  it("reads the spendable balance after refreshing unspents", async () => {
    const { init, account } = withFakes();
    await expect(init.getActualBalance()).resolves.toBe(2.5);
    expect(account.updateUnspents).toHaveBeenCalledTimes(1);
  });

  it("returns null balance without a wallet account", async () => {
    const { init, actions } = withFakes();
    actions.getCurrentAccount.mockReturnValueOnce(null as never);
    await expect(init.getActualBalance()).resolves.toBeNull();
  });

  it("lists every PeerTube server once", async () => {
    const { init, api } = withFakes();
    await expect(init.getPeertubeServers()).resolves.toEqual(["a.example", "arch.example", "b.example"]);
    expect(api.fetch).toHaveBeenCalledWith("peertube/allservers");
  });
});
