import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

/**
 * The vendored Pocketnet SDK (public/js/lib/client/sdk.js) must request
 * `getuserprofile` in the short form ([addresses, "1"]) for the logged-in
 * account too. The full form only adds subscribes / subscribers / blocking /
 * content lists the chat never reads, and they grow with the account's
 * audience. `light` keeps selecting the cache store (userInfoFull vs
 * userInfoLight). sdk.js runs in a vm sandbox, as in sdk-userinfo-cache.test.ts.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let PSDKCtor: any;

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sandbox: any = {};
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.console = console;
  sandbox.performance = performance;
  sandbox.setInterval = setInterval;
  sandbox.clearInterval = clearInterval;
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(resolve(process.cwd(), "public/js/vendor/underscore-min.js"), "utf-8"), sandbox);
  // cleanData helpers from the separately vendored functions.js — identity is enough here.
  const identity = (v: unknown) => v;
  sandbox.clearStringXss = identity;
  sandbox.checkIfAllowedImageApply = identity;
  sandbox.trydecode = identity;
  sandbox.ResoursesDB = class {
    getdb() {
      return Promise.resolve();
    }
  };
  sandbox.pUserInfo = class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _import(v: any) {
      Object.assign(this, v);
    }
  };
  vm.runInContext(readFileSync(resolve(process.cwd(), "public/js/lib/client/sdk.js"), "utf-8"), sandbox);
  PSDKCtor = sandbox.pSDK;
});

const ADDR = "PPbNqCweFnTePQyXWR21B9jXWCiDJa2yYu";

const createSdk = () => {
  const rpc = vi.fn().mockResolvedValue([{ address: ADDR, name: "Tech_support", k: "pub1,pub2", a: "about", s: "", l: "ru" }]);
  const instance = new PSDKCtor({
    app: {},
    api: { rpc },
    actions: { on: vi.fn(), getAccounts: vi.fn(() => []), getCurrentAccount: vi.fn(() => null) },
  });
  instance.db = { set: vi.fn().mockResolvedValue(undefined), get: vi.fn().mockResolvedValue(null) };
  return { instance, rpc };
};

describe("sdk.js userInfo.load — getuserprofile short form", () => {
  it("requests the short form for the logged-in account (light=false)", async () => {
    const { instance, rpc } = createSdk();
    await instance.userInfo.load([ADDR], false, true);
    expect(rpc).toHaveBeenCalledWith("getuserprofile", [[ADDR], "1"]);
  });

  it("still caches the logged-in account in userInfoFull", async () => {
    const { instance } = createSdk();
    await instance.userInfo.load([ADDR], false, true);
    expect(instance.db.set).toHaveBeenCalledWith("userInfoFull", expect.any(Number), ADDR, expect.anything());
    expect(instance.userInfo.get(ADDR)).toMatchObject({ address: ADDR, name: "Tech_support" });
  });
});
