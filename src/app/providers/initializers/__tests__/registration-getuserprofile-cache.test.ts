import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const appInitSrc = () =>
  readFileSync(resolve(__dirname, "../app-initializer.ts"), "utf-8");

const storesSrc = () =>
  readFileSync(
    resolve(__dirname, "../../../../entities/auth/model/stores.ts"),
    "utf-8",
  );

/**
 * During registration, SDK getuserprofile must bypass local memory + IndexedDB
 * cache (update:true → network). A pre-registration empty row must not hide
 * an account that already landed on-chain.
 */
describe("registration getuserprofile bypasses local SDK cache", () => {
  it("loadUserData forwards update to psdk.userInfo.load", () => {
    const src = appInitSrc();
    const start = src.indexOf("loadUserData(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, start + 900);
    expect(body).toContain("options?.update ?? false");
    expect(body).toMatch(
      /userInfo\.load\(\s*stateAddresses\s*,\s*false\s*,\s*options\?\.update\s*\?\?\s*false\s*\)/,
    );
  });

  it("initializeAndFetchUserData accepts and forwards update option", () => {
    const src = appInitSrc();
    const start = src.indexOf("initializeAndFetchUserData(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, start + 500);
    expect(body).toContain("options?: { update?: boolean }");
    expect(body).toContain("loadUserData([address], onLoad, options)");
  });

  it("phase 1 uses loadUsersInfoRaw (update:true) before waiting for PKOIN", () => {
    const src = storesSrc();
    const poll = src.slice(
      src.indexOf("const startRegistrationPoll"),
      src.indexOf("const stopRegistrationPoll"),
    );
    expect(poll).toContain("loadUsersInfoRaw");
    expect(poll).toContain("getuserprofile already has account during phase 1");
  });

  it("registration initializeAndFetchUserData calls pass update: true", () => {
    const src = storesSrc();
    const poll = src.slice(
      src.indexOf("const startRegistrationPoll"),
      src.indexOf("const stopRegistrationPoll"),
    );
    expect(poll).toContain("initializeAndFetchUserData(address.value, undefined, { update: true })");
    expect(poll).toContain("{ update: true }");
  });

  it("fetchUserInfo forces network while registration is pending", () => {
    const src = storesSrc();
    const start = src.indexOf("const fetchUserInfo = async");
    const end = src.indexOf("const verifyAndRepublishKeys");
    const body = src.slice(start, end > start ? end : start + 4000);
    expect(body).toContain("registrationPending.value || !!pendingRegProfile.value");
    expect(body).toContain("forceNetwork ? { update: true } : undefined");
  });
});
