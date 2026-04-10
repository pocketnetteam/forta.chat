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
    const fnSection = source.slice(fnStart, fnStart + 3000);
    // Should check cache first
    expect(fnSection).toContain("cachedKeys.length >= 12");
    // Should fallback to blockchain RPC
    expect(fnSection).toContain("loadUsersInfoRaw");
    expect(fnSection).toContain("blockchainKeys.length >= 12");
  });

  it("verifyAndRepublishKeys should not block login if RPC fails", () => {
    const source = getSource();
    const fnStart = source.indexOf("const verifyAndRepublishKeys");
    const fnSection = source.slice(fnStart, fnStart + 3000);
    expect(fnSection).toContain("skipping re-publish");
  });

  it("verifyAndRepublishKeys should cache verification result in localStorage", () => {
    const source = getSource();
    const fnStart = source.indexOf("const verifyAndRepublishKeys");
    const fnSection = source.slice(fnStart, fnStart + 3000);
    expect(fnSection).toContain("KEY_VERIFY_LS_PREFIX");
    expect(fnSection).toContain("KEY_VERIFY_TTL");
    expect(fnSection).toContain("localStorage.getItem");
    expect(fnSection).toContain("localStorage.setItem");
  });
});
