import { describe, expect, it } from "vitest";
import { initializeChatConfig } from "./index";

describe("initializeChatConfig", () => {
  it("aliases window.app to window.POCKETNETINSTANCE (same object reference)", () => {
    initializeChatConfig();

    // The vendor Bastyon SDK (actions.js/api.js/sdk.js) reads a bare global
    // `app` in several places instead of `parent.app`/`self.app` (e.g.
    // actions.js Account.loadUnspents → `app.platform.currentBlock`). Without
    // this alias, Actions/Api/pSDK construction leaves `window.app`
    // undefined and vendor calls throw "Cannot read properties of undefined
    // (reading 'currentBlock')".
    expect(window.app).toBeDefined();
    expect(window.app).toBe(window.POCKETNETINSTANCE);
    expect(window.app.platform).toBeDefined();
  });

  it("keeps window.app in sync with mutations made via POCKETNETINSTANCE", () => {
    initializeChatConfig();

    window.POCKETNETINSTANCE.user.address.value = "PSomeAddress";

    // Same object reference — no separate write path needed.
    expect(window.app.user.address.value).toBe("PSomeAddress");
  });

  it("stubs platform.sdk.addresses.storage so Actions SDK unspent lookups don't throw", () => {
    initializeChatConfig();

    // actions.js Account.loadUnspents reads
    // parent.app.platform.sdk.addresses.storage.addresses to fold extra
    // wallet addresses into unspent lookups (WEE registration regression:
    // "Cannot read properties of undefined (reading 'storage')" once
    // window.app was aliased and the code could reach this far).
    expect(window.app.platform.sdk.addresses.storage.addresses).toEqual([]);
    expect(window.app.platform.sdk.addresses.storage.addressesobj).toEqual([]);
  });
});
