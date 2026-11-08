import { describe, it, expect } from "vitest";
import { isLocalNodeProxyAvailable } from "./is-local-node-available";

describe("isLocalNodeProxyAvailable", () => {
  it("is true on native and electron", () => {
    expect(isLocalNodeProxyAvailable({ isNative: true, isElectron: false })).toBe(true);
    expect(isLocalNodeProxyAvailable({ isNative: false, isElectron: true })).toBe(true);
  });

  it("is true on localhost web", () => {
    expect(
      isLocalNodeProxyAvailable({
        isNative: false,
        isElectron: false,
        hostname: "localhost",
      }),
    ).toBe(true);
    expect(
      isLocalNodeProxyAvailable({
        isNative: false,
        isElectron: false,
        hostname: "127.0.0.1",
      }),
    ).toBe(true);
  });

  it("is false on production web hostnames", () => {
    expect(
      isLocalNodeProxyAvailable({
        isNative: false,
        isElectron: false,
        hostname: "forta.chat",
      }),
    ).toBe(false);
  });

  it("honours forceLocalNode override", () => {
    expect(
      isLocalNodeProxyAvailable({
        isNative: false,
        isElectron: false,
        hostname: "forta.chat",
        forceLocalNode: true,
      }),
    ).toBe(true);
  });
});
