import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const getStoresSource = () =>
  readFileSync(resolve(__dirname, "../stores.ts"), "utf-8");
const getConfiguratorSource = () =>
  readFileSync(
    resolve(
      __dirname,
      "../../../../app/providers/chat-scripts/config/configurator.ts",
    ),
    "utf-8",
  );
const getAppInitializerSource = () =>
  readFileSync(
    resolve(
      __dirname,
      "../../../../app/providers/initializers/app-initializer.ts",
    ),
    "utf-8",
  );

describe("registration: proxy rotation & resilience (session 05)", () => {
  it("stores.ts wires ProxyRotator for registration calls", () => {
    const src = getStoresSource();
    // Must import ProxyRotator
    expect(src).toMatch(/ProxyRotator/);
  });

  it("retryRegistration resets the poll timer baseline", () => {
    const src = getStoresSource();
    // Locate the `retryRegistration` (NOT `retryRegistrationWithNewName`)
    // definition — declared as `const retryRegistration = (` with open paren,
    // which avoids matching the "WithNewName" variant.
    const retryFnStart = src.indexOf("const retryRegistration =");
    expect(retryFnStart).toBeGreaterThan(-1);
    const retryFn = src.slice(retryFnStart, retryFnStart + 600);
    // Either resetStart() on a PollTimer or explicit pollStartedAt reassignment
    expect(retryFn).toMatch(/resetStart|pollStartedAt\s*=\s*Date\.now/);
  });

  it("registration poll uses PollTimer (not raw Date.now diff)", () => {
    const src = getStoresSource();
    const pollStart = src.indexOf("const startRegistrationPoll");
    const pollEnd = src.indexOf("const stopRegistrationPoll");
    const pollSection = src.slice(pollStart, pollEnd);
    // Should delegate elapsed/expired check to PollTimer — this prevents the
    // "background accumulates 12 hours → timeout fires instantly" bug.
    expect(pollSection).toMatch(/PollTimer|isExpired|pollTimer\.elapsed/);
  });

  it("registration reacts to background/visibility changes (pause poll)", () => {
    const src = getStoresSource();
    // Either Capacitor App.addListener('appStateChange') or document.visibilitychange
    expect(src).toMatch(/appStateChange|visibilitychange/);
  });

  it("mnemonic is persisted through sessionStorage-backed helper", () => {
    const src = getStoresSource();
    // Must use the mnemonic-storage helper so unmount cannot lose the seed
    expect(src).toMatch(/saveMnemonic|mnemonic-storage/);
    expect(src).toMatch(/loadMnemonic|mnemonic-storage/);
    expect(src).toMatch(/clearMnemonic|mnemonic-storage/);
  });

  it("clearGlobalUser() exists on PocketnetInstanceConfigurator", () => {
    const src = getConfiguratorSource();
    expect(src).toMatch(/clearGlobalUser|clearUserAddress/);
    expect(src).toMatch(/address\.value\s*=\s*null/);
  });

  it("logout() clears the global PocketnetInstance.user.address.value", () => {
    const src = getStoresSource();
    const logoutStart = src.indexOf("const logout = async");
    expect(logoutStart).toBeGreaterThan(-1);
    const logoutFn = src.slice(logoutStart, logoutStart + 3000);
    expect(logoutFn).toMatch(/clearGlobalUser|clearUserAddress/);
  });

  it("editUserData is wrapped with withTimeout + returns structured success/failure", () => {
    const src = getAppInitializerSource();
    const editStart = src.indexOf("async editUserData");
    expect(editStart).toBeGreaterThan(-1);
    const editFn = src.slice(editStart, editStart + 1500);
    expect(editFn).toContain("withTimeout");
    // Return structured error — either success:false or reason:...
    expect(editFn).toMatch(/success:\s*false|reason:\s*['"]/);
  });
});
