import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Reload boot: with the own profile (keys + numeric id) cached by an earlier
 * session, Matrix starts without waiting for the Bastyon proxy; without it the
 * profile still loads first. App.vue wires the real stores and router, so the
 * order is asserted on the source.
 */

const read = (path: string) => readFileSync(resolve(__dirname, path), "utf-8").replace(/\r\n/g, "\n");
const appSrc = () => read("../App.vue");
const storesSrc = () => read("../../entities/auth/model/stores.ts");

describe("App boot — Matrix does not wait for the proxy when the profile is cached", () => {
  it("starts the profile load without awaiting it and awaits it only without a cached profile", () => {
    const src = appSrc();
    const start = src.indexOf("const profileLoad = authStore.fetchUserInfo()");
    const gate = src.indexOf("if (!startMatrixWithoutProfile) await profileLoad;");
    const initMatrix = src.indexOf("await authStore.initMatrix();");
    expect(start).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(start);
    expect(initMatrix).toBeGreaterThan(gate);
    expect(src).not.toMatch(/await authStore\.fetchUserInfo\(\)/);
  });

  it("never skips the profile during a pending registration", () => {
    const src = appSrc();
    const decl = src.slice(src.indexOf("const startMatrixWithoutProfile"), src.indexOf("if (!startMatrixWithoutProfile)"));
    expect(decl).toContain("!authStore.registrationPending");
    expect(decl).toContain("authStore.hasCachedOwnProfile()");
  });

  it("still finishes the profile before referral / join links", () => {
    const src = appSrc();
    expect(src.indexOf("await profileLoad;\n  await processReferral();")).toBeGreaterThan(-1);
  });

  it("counts the profile as cached only with all encryption keys and the account id", () => {
    const src = storesSrc();
    const body = src.slice(src.indexOf("const hasCachedOwnProfile"), src.indexOf("/** Initialize Matrix client, kit and crypto after login */"));
    expect(body).toContain("readSelfProfile(address.value)");
    expect(body).toContain("cached.keys.length >= REQUIRED_ENCRYPTION_KEYS");
    expect(body).toContain("cached.id != null");
  });

  it("pushes the display name once the profile arrives after Matrix", () => {
    const src = storesSrc();
    const fetchUserInfo = src.slice(src.indexOf("const fetchUserInfo = async"), src.indexOf("const verifyAndRepublishKeys"));
    expect(fetchUserInfo).toContain("setUserInfo(merged);\n            syncOwnDisplayNameToMatrix();");
  });
});
