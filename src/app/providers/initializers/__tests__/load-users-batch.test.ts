import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

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

const mockUserInfoLoad = vi.fn().mockResolvedValue(undefined);
const mockUserInfoGet = vi.fn();

import { createAppInitializer } from "../app-initializer";

describe("AppInitializer.loadUsersBatch — source regression", () => {
  it("defines loadUsersBatch as a real class method (not inside a JSDoc comment)", () => {
    const src = readFileSync(resolve(__dirname, "../app-initializer.ts"), "utf-8");
    expect(src).toMatch(
      /async loadUsersBatch\(addresses: string\[\]\): Promise<void> \{\s*\n\s*if \(!this\.psdk \|\| !addresses\.length\) return;\s*\n\s*await this\.psdk\.userInfo\.load\(addresses\);/,
    );
  });
});

describe("AppInitializer.loadUsersBatch — runtime behavior", () => {
  beforeEach(() => {
    mockUserInfoLoad.mockClear();
    mockUserInfoGet.mockReset();
    mockUserInfoGet.mockImplementation((addr: string) => ({
      name: `User ${addr}`,
      about: "",
      image: "avatar.png",
      site: "",
      language: "",
      address: addr,
    }));

    vi.stubGlobal("Api", class {
      initIf() { return Promise.resolve(); }
      wait = { ready: () => Promise.resolve(true) };
      ready = { use: true };
      rpc() { return Promise.resolve({ time: 0 }); }
    });
    vi.stubGlobal("Actions", class {
      init() { /* no-op */ }
      prepare() { /* no-op */ }
    });
    vi.stubGlobal("pSDK", class {
      userInfo = {
        load: mockUserInfoLoad,
        get: mockUserInfoGet,
      };
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls userInfo.load with full cache (no light=true)", async () => {
    const init = createAppInitializer();
    const addresses = ["PAddr1111111111111111111111111111", "PAddr2222222222222222222222222222"];

    await init.loadUsersBatch(addresses);

    expect(mockUserInfoLoad).toHaveBeenCalledTimes(1);
    expect(mockUserInfoLoad).toHaveBeenCalledWith(addresses);
    expect(mockUserInfoLoad).not.toHaveBeenCalledWith(addresses, true, expect.anything());
  });

  it("exposes cached profiles via getUserData after batch load", async () => {
    const init = createAppInitializer();
    const addr = "PAddr1111111111111111111111111111";

    await init.loadUsersBatch([addr]);

    const data = init.getUserData(addr);
    expect(data).toMatchObject({ name: `User ${addr}`, image: "avatar.png" });
  });

  it("no-ops on empty address list", async () => {
    const init = createAppInitializer();
    await init.loadUsersBatch([]);
    expect(mockUserInfoLoad).not.toHaveBeenCalled();
  });
});
