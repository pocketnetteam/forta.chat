import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const getSource = () => readFileSync(resolve(__dirname, "../stores.ts"), "utf-8");

describe("registration poll", () => {
  it("should not have a hardcoded 5-minute timeout", () => {
    const source = getSource();
    expect(source).not.toContain("MAX_WAIT_MS");
    expect(source).not.toContain("5 * 60 * 1000");
  });

  it("should use setTimeout instead of setInterval for backoff", () => {
    const source = getSource();
    // The poll function should use setTimeout, not setInterval
    const pollSection = source.slice(
      source.indexOf("const startRegistrationPoll"),
      source.indexOf("const stopRegistrationPoll")
    );
    expect(pollSection).toContain("setTimeout");
    expect(pollSection).not.toContain("setInterval");
  });

  it("should use exponential backoff with 60s cap", () => {
    const source = getSource();
    const pollSection = source.slice(
      source.indexOf("const startRegistrationPoll"),
      source.indexOf("const stopRegistrationPoll")
    );
    expect(pollSection).toContain("Math.min");
    expect(pollSection).toContain("60000");
  });

  it("should use clearTimeout in stopRegistrationPoll", () => {
    const source = getSource();
    const stopSection = source.slice(
      source.indexOf("const stopRegistrationPoll"),
      source.indexOf("const stopRegistrationPoll") + 200
    );
    expect(stopSection).toContain("clearTimeout");
  });

  it("should call loadUsersInfo with update:true before initializeAndFetchUserData on registration confirmed", () => {
    const source = getSource();
    const fnStart = source.indexOf("async function onRegistrationConfirmed");
    expect(fnStart).toBeGreaterThan(-1);
    const fnSection = source.slice(fnStart, fnStart + 1200);
    const loadIdx = fnSection.indexOf("loadUsersInfo([address.value!], { update: true })");
    const initIdx = fnSection.indexOf("initializeAndFetchUserData");
    expect(loadIdx).toBeGreaterThan(-1);
    expect(initIdx).toBeGreaterThan(loadIdx);
  });
});

describe("login key verification", () => {
  it("should have verifyAndRepublishKeys function", () => {
    const source = getSource();
    expect(source).toContain("verifyAndRepublishKeys");
  });

  it("login should call verifyAndRepublishKeys between fetchUserInfo and initMatrix", () => {
    const source = getSource();
    const loginSection = source.slice(
      source.indexOf("execute: login"),
      source.indexOf("execute: login") + 800
    );
    const fetchPos = loginSection.indexOf("fetchUserInfo");
    const verifyPos = loginSection.indexOf("verifyAndRepublishKeys");
    const matrixPos = loginSection.indexOf("initMatrix");
    expect(fetchPos).toBeGreaterThan(-1);
    expect(verifyPos).toBeGreaterThan(fetchPos);
    expect(matrixPos).toBeGreaterThan(verifyPos);
  });

  it("verifyAndRepublishKeys should check keys via both cache and RPC", () => {
    const source = getSource();
    const fnStart = source.indexOf("const verifyAndRepublishKeys");
    const fnSection = source.slice(fnStart, fnStart + 2000);
    // Should check cache first
    expect(fnSection).toContain("cachedKeys.length >= 12");
    // Fresh profile via SDK (loadUsersInfoRaw wraps loadUsersInfo + getRawProfile)
    expect(fnSection).toContain("loadUsersInfoRaw");
    expect(fnSection).toContain("blockchainKeys.length >= 12");
  });

  it("verifyAndRepublishKeys should not block login if RPC fails", () => {
    const source = getSource();
    const fnStart = source.indexOf("const verifyAndRepublishKeys");
    const fnSection = source.slice(fnStart, fnStart + 2600);
    expect(fnSection).toContain("RPC key check failed");
  });
});

describe("pcrypto getUsersInfo profile load", () => {
  it("should use a single loadUsersInfo batch and getUserData, not parallel loadUsersInfoRaw", () => {
    const source = getSource();
    const idx = source.indexOf("getUsersInfo: async");
    expect(idx).toBeGreaterThan(-1);
    const section = source.slice(idx, idx + 4500);
    expect(section).toContain("loadUsersInfo(rawAddresses, { update: false })");
    expect(section).toContain("getUserData");
    expect(section).not.toContain("loadUsersInfoRaw");
  });
});
