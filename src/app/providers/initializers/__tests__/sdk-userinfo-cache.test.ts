import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

/**
 * Regression test for the userInfo IndexedDB cache guard in the vendored
 * Pocketnet SDK (public/js/lib/client/sdk.js). A profile with a name but no
 * published encryption keys must not be persisted as if it were valid — see
 * plan "Fix: userinfo cache doesn't account for missing encryption keys".
 *
 * sdk.js is a plain browser `<script>` (no bundler, no ES `export`
 * statements) loaded the same way index.html loads it — as a classic
 * script attaching `window.pSDK` as a side effect. It can't be `require()`d
 * or `import()`ed cleanly here (this project is "type": "module", which
 * makes both interpret it as an ES module with no CJS/window bindings
 * available, so it silently fails to attach anything). Instead we run the
 * real source text in a `vm` sandbox with a minimal `window`/`performance`/
 * `ResoursesDB`, exactly mirroring how a browser executes it — this
 * exercises the actual `settodb`/`insertFromResponse` logic, not a mock.
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

  const underscoreSrc = readFileSync(
    resolve(process.cwd(), "public/js/vendor/underscore-min.js"),
    "utf-8",
  );
  vm.runInContext(underscoreSrc, sandbox);
  expect(typeof sandbox._).toBe("function");

  // sdk.js constructs `new ResoursesDB(...)` for IndexedDB persistence — not
  // under test here, we intercept at `instance.db` instead (see below).
  sandbox.ResoursesDB = class {
    getdb() {
      return Promise.resolve();
    }
  };

  // `userInfo.insertFromResponse` builds a `pUserInfo` (defined in the
  // separate vendored actions.js) after persisting — irrelevant to the
  // settodb cache-guard under test, so a bare stub is enough to avoid
  // pulling in that whole file.
  sandbox.pUserInfo = class {
    _import() {
      /* no-op stub */
    }
  };

  const sdkSrc = readFileSync(
    resolve(process.cwd(), "public/js/lib/client/sdk.js"),
    "utf-8",
  );
  vm.runInContext(sdkSrc, sandbox);

  PSDKCtor = sandbox.pSDK;
  expect(typeof PSDKCtor).toBe("function");
});

describe("sdk.js userInfo cache — encryption key guard", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fakeDb: { set: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let instance: any;

  beforeEach(() => {
    instance = new PSDKCtor({
      app: {},
      api: {},
      actions: { on: vi.fn(), getAccounts: vi.fn(() => []), getCurrentAccount: vi.fn(() => null) },
    });
    fakeDb = { set: vi.fn().mockResolvedValue(undefined), get: vi.fn() };
    // `self.db` is assigned as an instance property in the pSDK constructor
    // (`self.db = new ResoursesDB(...)`), so it's safe to swap post-construction.
    instance.db = fakeDb;
  });

  it("does not persist a peer profile with no published encryption keys", async () => {
    await instance.userInfo.insertFromResponse(
      [{ address: "addr-no-keys", name: "Alice", k: [] }],
      true,
    );

    expect(fakeDb.set).not.toHaveBeenCalled();
  });

  it("does not persist when keys come as an empty comma-separated string", async () => {
    await instance.userInfo.insertFromResponse(
      [{ address: "addr-empty-string-keys", name: "Alice", k: "" }],
      true,
    );

    expect(fakeDb.set).not.toHaveBeenCalled();
  });

  it("persists a peer profile that has published encryption keys", async () => {
    await instance.userInfo.insertFromResponse(
      [{ address: "addr-with-keys", name: "Bob", k: ["pub1", "pub2"] }],
      true,
    );

    expect(fakeDb.set).toHaveBeenCalledWith(
      "userInfoLight",
      expect.any(Number),
      "addr-with-keys",
      expect.objectContaining({ address: "addr-with-keys" }),
    );
  });

  it("still does not persist a profile with no name (pre-existing behavior)", async () => {
    await instance.userInfo.insertFromResponse(
      [{ address: "addr-no-name", name: "", k: ["pub1"] }],
      true,
    );

    expect(fakeDb.set).not.toHaveBeenCalled();
  });
});
