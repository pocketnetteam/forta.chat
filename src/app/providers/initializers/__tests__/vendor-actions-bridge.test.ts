import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * AppInitializer is the bridge to the vendor Actions SDK
 * (public/js/lib/client/actions.js). Registration relies on the SDK's own
 * engine, which needs what Bastyon's satolist.js provides:
 * `platform.sdk.node.transactions.get.tx`, `platform.currentBlock`,
 * `actions.ws.*` feeding, post-login `account.setStatus(true)`, and the
 * `willChangeUnspentsCallback` hand-off after free/balance.
 */

const instance = vi.hoisted(() => ({
  options: { listofproxies: null },
  platform: {
    sdk: {} as Record<string, unknown>,
    currentBlock: undefined as number | undefined,
  },
}));

vi.mock("../../chat-scripts", () => ({
  PocketnetInstanceConfigurator: { setTimeDifference: vi.fn() },
}));
vi.mock("../../chat-scripts/config/pocketnetinstance", () => ({
  PocketnetInstance: instance,
}));

import { createAppInitializer } from "../app-initializer";

type Listener = (data: unknown) => void;

function makeAccount() {
  return {
    status: { value: null as boolean | null },
    unspents: { value: [] as unknown[] },
    getStatus: vi.fn(() => "not_in_progress"),
    setStatus: vi.fn(),
    updateUnspents: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
    loadUnspents: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
    willChangeUnspentsCallback: vi.fn(),
    getTempUserInfo: vi.fn((): unknown => null),
    getTempActions: vi.fn((): Array<{ id: string }> => []),
  };
}

let account: ReturnType<typeof makeAccount>;
let actions: {
  ws: { transaction: ReturnType<typeof vi.fn>; block: ReturnType<typeof vi.fn> };
  addActionAndSendIfCan: ReturnType<typeof vi.fn>;
  cancelAction: ReturnType<typeof vi.fn>;
  emit(key: string, data: unknown): void;
};
let txLoad: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;
let rpcImpl: (method: string, params?: unknown) => Promise<unknown>;

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("AppInitializer ↔ Actions SDK bridge", () => {
  beforeEach(() => {
    instance.platform.sdk = {};
    instance.platform.currentBlock = undefined;
    account = makeAccount();
    txLoad = vi.fn();
    rpcImpl = async () => null;

    vi.stubGlobal(
      "Api",
      class {
        initIf() { return Promise.resolve(); }
        wait = { ready: () => Promise.resolve() };
        ready = { use: true };
        rpc(method: string, params?: unknown) { return rpcImpl(method, params); }
      },
    );
    vi.stubGlobal(
      "Actions",
      class {
        private listeners: Record<string, Listener[]> = {};
        ws = { transaction: vi.fn(), block: vi.fn() };
        addActionAndSendIfCan = vi.fn(async (object: unknown) => ({ id: "queued-1", object }));
        cancelAction = vi.fn(async () => {});
        constructor() {
          // eslint-disable-next-line @typescript-eslint/no-this-alias
          actions = this;
        }
        init() {}
        addAccount() { return account; }
        on(key: string, f: Listener) { (this.listeners[key] ??= []).push(f); }
        off(key: string, f: Listener) {
          this.listeners[key] = (this.listeners[key] ?? []).filter((x) => x !== f);
        }
        emit(key: string, data: unknown) { (this.listeners[key] ?? []).forEach((f) => f(data)); }
      },
    );
    vi.stubGlobal(
      "pSDK",
      class {
        transaction = { load: (...args: unknown[]) => txLoad(...args) };
      },
    );
    const field = () => ({ set: vi.fn() });
    vi.stubGlobal(
      "UserInfo",
      class {
        name = field(); language = field(); about = field(); site = field();
        image = field(); addresses = field(); ref = field(); keys = field();
      },
    );
    vi.stubGlobal("superXSS", (v: string) => v);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const getTx = () =>
    (instance.platform.sdk as {
      node: { transactions: { get: { tx: (id: string, clbk?: (d: unknown, e?: unknown) => void) => void } } };
    }).node.transactions.get.tx;

  describe("platform.sdk.node.transactions.get.tx", () => {
    it("is installed and resolves through psdk.transaction.load, like satolist.js", async () => {
      txLoad.mockResolvedValue({ txid: "t1", confirmations: 2 });
      createAppInitializer();
      const clbk = vi.fn();

      getTx()("t1", clbk);
      await flush();

      expect(txLoad).toHaveBeenCalledWith("t1", false, undefined);
      expect(clbk).toHaveBeenCalledWith({ txid: "t1", confirmations: 2 }, undefined);
    });

    it("hands a load failure to the vendor callback as (null, error) — checkTransaction reads error.code -5", async () => {
      txLoad.mockRejectedValue({ code: -5 });
      createAppInitializer();
      const clbk = vi.fn();

      getTx()("missing", clbk);
      await flush();

      expect(clbk).toHaveBeenCalledTimes(1);
      expect(clbk).toHaveBeenCalledWith(null, { code: -5 });
    });

    it("contains a throwing vendor callback instead of re-invoking it with an error", async () => {
      txLoad.mockResolvedValue(null);
      createAppInitializer();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // Account.ws.transaction dereferences data.vout — throws on null data
      const clbk = vi.fn(() => { throw new TypeError("vendor bug"); });

      getTx()("t1", clbk);
      await flush();

      expect(clbk).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it("keeps an existing implementation (running inside Bastyon)", () => {
      const existing = vi.fn();
      instance.platform.sdk = { node: { transactions: { get: { tx: existing } } } };
      createAppInitializer();
      expect(getTx()).toBe(existing);
    });
  });

  describe("platform.currentBlock", () => {
    it("getBlockHeight publishes the height for the Actions SDK", async () => {
      rpcImpl = async (method) => (method === "getnodeinfo" ? { height: 3_000_000 } : null);
      const init = createAppInitializer();

      await init.getBlockHeight();

      expect(instance.platform.currentBlock).toBe(3_000_000);
    });

    it("never moves backwards and ignores a zero height", () => {
      const init = createAppInitializer();
      init.setCurrentBlock(100);
      init.setCurrentBlock(90);
      init.setCurrentBlock(0);
      expect(instance.platform.currentBlock).toBe(100);
    });
  });

  describe("blockchain-ws → actions.ws", () => {
    it("forwardChainBlock updates currentBlock and feeds actions.ws.block", () => {
      const init = createAppInitializer();
      init.forwardChainBlock({ height: 500, difference: 2 });
      expect(instance.platform.currentBlock).toBe(500);
      expect(actions.ws.block).toHaveBeenCalledWith({ height: 500, difference: 2 });
    });

    it("forwardChainTransaction feeds actions.ws.transaction and swallows SDK errors", () => {
      const init = createAppInitializer();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      actions.ws.transaction.mockImplementationOnce(() => { throw new Error("boom"); });

      expect(() => init.forwardChainTransaction({ txid: "tx9" })).not.toThrow();
      expect(actions.ws.transaction).toHaveBeenCalledWith({ txid: "tx9" });
      warn.mockRestore();
    });
  });

  describe("syncActionsAccountStatus (satolist.js prepareUser)", () => {
    it("marks the account registered when getuserstate knows it, and warms unspents", async () => {
      rpcImpl = async (method) => (method === "getuserstate" ? { address: "P1" } : null);
      const init = createAppInitializer();

      await expect(init.syncActionsAccountStatus("P1")).resolves.toBe(true);

      expect(account.setStatus).toHaveBeenCalledWith(true);
      expect(account.updateUnspents).toHaveBeenCalled();
    });

    it("leaves the status alone when the chain has no account yet", async () => {
      rpcImpl = async () => null;
      const init = createAppInitializer();

      await expect(init.syncActionsAccountStatus("P1")).resolves.toBe(false);

      expect(account.setStatus).not.toHaveBeenCalled();
      expect(account.updateUnspents).toHaveBeenCalled();
    });
  });

  it("markRegistrationFundingPending hands the free/balance grant to willChangeUnspentsCallback", () => {
    const init = createAppInitializer();
    init.markRegistrationFundingPending("P1", { id: "grant" }, "proxy-1");
    expect(account.willChangeUnspentsCallback).toHaveBeenCalledWith({ id: "grant" }, "proxy-1");
  });

  describe("queueRegistrationUserInfo", () => {
    const profile = { name: "alice", language: "en", about: "" };

    it("adopts a live UserInfo action (e.g. restored from actions_v0) instead of queuing a second one", async () => {
      const live = { id: "restored", transaction: "tx1", object: { type: "userInfo" } };
      account.getTempUserInfo.mockReturnValue(live);
      const init = createAppInitializer();

      await expect(init.queueRegistrationUserInfo("P1", profile, ["k1"])).resolves.toBe(live);
      expect(actions.addActionAndSendIfCan).not.toHaveBeenCalled();
    });

    it("queues exactly one UserInfo when none is live, without forcing a send", async () => {
      const init = createAppInitializer();

      const action = await init.queueRegistrationUserInfo("P1", profile, ["k1"]);

      expect(actions.addActionAndSendIfCan).toHaveBeenCalledTimes(1);
      expect(actions.addActionAndSendIfCan.mock.calls[0][2]).toBe("P1");
      expect(action?.id).toBe("queued-1");
    });
  });

  it("refreshActionsUnspents reloads the SDK account's unspents and reports the count", async () => {
    account.loadUnspents.mockImplementation(async () => {
      account.unspents.value = [{ txid: "u1" }];
      return account.unspents.value;
    });
    const init = createAppInitializer();

    await expect(init.refreshActionsUnspents("P1")).resolves.toBe(1);
  });

  it("cancelRegistrationUserInfo cancels every live UserInfo action through the SDK", async () => {
    account.getTempActions.mockReturnValue([{ id: "a1" }, { id: "a2" }]);
    const init = createAppInitializer();

    await init.cancelRegistrationUserInfo("P1");

    expect(account.getTempActions).toHaveBeenCalledWith("userInfo", null, true);
    expect(actions.cancelAction).toHaveBeenCalledWith("P1", "a1");
    expect(actions.cancelAction).toHaveBeenCalledWith("P1", "a2");
  });

  it("getAccountRegistrationStatus(address) reads that account's vendor status", () => {
    account.getStatus.mockReturnValue("in_progress_hasUnspents");
    const init = createAppInitializer();
    expect(init.getAccountRegistrationStatus("P1")).toBe("in_progress_hasUnspents");
  });

  describe("onUserInfoActionStateChange", () => {
    it("fires only for this address' UserInfo actions and only on real transitions", () => {
      const init = createAppInitializer();
      const onChange = vi.fn();
      const unsubscribe = init.onUserInfoActionStateChange("P1", onChange);
      const ui = { id: "a1", object: { type: "userInfo" } };

      actions.emit("action", { address: "P2", action: ui }); // other account
      actions.emit("action", { address: "P1", action: { id: "c1", object: { type: "comment" } } });
      actions.emit("action", { address: "P1", action: ui }); // queued
      actions.emit("action", { address: "P1", action: ui }); // same state re-emitted
      actions.emit("action", { address: "P1", action: { ...ui, transaction: "tx1" } }); // sent

      expect(onChange).toHaveBeenCalledTimes(2);
      expect(onChange).toHaveBeenLastCalledWith({ kind: "sent", txid: "tx1" });

      unsubscribe();
      actions.emit("action", { address: "P1", action: { ...ui, completed: true } });
      expect(onChange).toHaveBeenCalledTimes(2);
    });
  });
});
