import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const getSource = () => readFileSync(resolve(__dirname, "../stores.ts"), "utf-8");

describe("pCrypto getUsersInfo cache", () => {
  it("should have an in-memory crypto profile cache", () => {
    const source = getSource();
    expect(source).toContain("_cryptoProfileCache");
    expect(source).toContain("CRYPTO_CACHE_TTL");
  });

  it("should use 7-day TTL for crypto cache", () => {
    const source = getSource();
    expect(source).toContain("7 * 24 * 60 * 60 * 1000");
  });

  it("should split ids into cached vs uncached before network calls", () => {
    const source = getSource();
    // The callback should check cache first
    expect(source).toContain("uncachedIndices");
    expect(source).toContain("_cryptoProfileCache.get");
  });

  it("should skip cache for own address during registration", () => {
    const source = getSource();
    // Should check registrationPending and myRawAddr
    expect(source).toContain("isRegPending");
    expect(source).toContain("myRawAddr");
  });

  it("should only call loadUsersInfo and loadUsersInfoRaw for uncached addresses", () => {
    const source = getSource();
    const callbackSection = source.slice(
      source.indexOf("getUsersInfo: async (ids"),
      source.indexOf("isTetatetChat"),
    );
    // Should call loadUsersInfo with uncachedAddrs, not all rawAddresses
    expect(callbackSection).toContain("loadUsersInfo(uncachedAddrs)");
    expect(callbackSection).toContain("loadUsersInfoRaw(uncachedAddrs)");
  });
});

describe("app-initializer light mode", () => {
  const getAppInitSource = () => readFileSync(
    resolve(__dirname, "../../../../app/providers/initializers/app-initializer.ts"),
    "utf-8",
  );

  it("loadUsersBatch should use light mode (true) for psdk.userInfo.load", () => {
    const source = getAppInitSource();
    const fn = source.slice(
      source.indexOf("async loadUsersBatch"),
      source.indexOf("async loadUsersBatch") + 200,
    );
    expect(fn).toContain("userInfo.load(addresses, true)");
  });

  it("loadUserData should use light mode (true) for psdk.userInfo.load", () => {
    const source = getAppInitSource();
    const defIdx = source.indexOf("  loadUserData(");
    expect(defIdx).toBeGreaterThan(-1);
    const fn = source.slice(defIdx, defIdx + 400);
    expect(fn).toContain("userInfo.load(stateAddresses, true)");
  });
});

describe("pCrypto getUsersInfo empty-key protection", () => {
  it("should only cache entries with keys.length >= 12", () => {
    const source = getSource();
    const callbackSection = source.slice(
      source.indexOf("getUsersInfo: async (ids"),
      source.indexOf("isTetatetChat"),
    );
    expect(callbackSection).toContain("entry.keys.length >= 12");
    expect(callbackSection).toContain("_cryptoProfileCache.set(rawAddr, { result: entry, ts: now })");
  });

  it("should prefer stale cache when new fetch returns empty keys", () => {
    const source = getSource();
    const callbackSection = source.slice(
      source.indexOf("getUsersInfo: async (ids"),
      source.indexOf("isTetatetChat"),
    );
    expect(callbackSection).toContain("stale.result.keys.length >= 12");
    expect(callbackSection).toContain("results[i] = stale.result");
  });

  it("should prefer stale cache in outer catch block", () => {
    const source = getSource();
    const catchSection = source.slice(
      source.indexOf("[pcrypto] getUsersInfo error"),
      source.indexOf("[pcrypto] getUsersInfo error") + 400,
    );
    expect(catchSection).toContain("_cryptoProfileCache.get");
    expect(catchSection).toContain("stale.result.keys.length >= 12");
  });
});

describe("app-initializer nodeinfo static cache and fallback", () => {
  const getAppInitSource = () => readFileSync(
    resolve(__dirname, "../../../../app/providers/initializers/app-initializer.ts"),
    "utf-8",
  );

  it("_lastNodeInfo and _nodeInfoPromise should be static fields", () => {
    const source = getAppInitSource();
    expect(source).toContain("private static _lastNodeInfo");
    expect(source).toContain("private static _nodeInfoPromise");
  });

  it("_getNodeInfoThrottled should reference AppInitializer._lastNodeInfo (static)", () => {
    const source = getAppInitSource();
    const fn = source.slice(
      source.indexOf("_getNodeInfoThrottled"),
      source.indexOf("syncNodeTime"),
    );
    expect(fn).toContain("AppInitializer._lastNodeInfo");
    expect(fn).toContain("AppInitializer._nodeInfoPromise");
  });

  it("should return stale _lastNodeInfo on RPC failure instead of throwing", () => {
    const source = getAppInitSource();
    const catchSection = source.slice(
      source.indexOf("getnodeinfo RPC failed"),
      source.indexOf("getnodeinfo RPC failed") + 200,
    );
    expect(catchSection).toContain("AppInitializer._lastNodeInfo.data");
  });

  it("should still throw if no stale cache is available", () => {
    const source = getAppInitSource();
    const catchStart = source.indexOf("getnodeinfo RPC failed");
    const fn = source.slice(catchStart, catchStart + 300);
    expect(fn).toContain("throw e;");
  });
});

describe("fetchUserInfo own-address cache", () => {
  it("should check user-store cache before calling initializeAndFetchUserData", () => {
    const source = getSource();
    const fn = source.slice(
      source.indexOf("const fetchUserInfo"),
      source.indexOf("const fetchUserInfo") + 1500,
    );
    expect(fn).toContain("uStore.getUser(address.value)");
    expect(fn).toContain("cached?.name && cached.cachedAt");
  });

  it("should skip network if cached profile is fresh (7-day TTL)", () => {
    const source = getSource();
    const fn = source.slice(
      source.indexOf("const fetchUserInfo"),
      source.indexOf("const fetchUserInfo") + 1500,
    );
    expect(fn).toContain("7 * 24 * 60 * 60 * 1000");
    expect(fn).toContain("using cached profile");
  });

  it("should still initialize pSDK in background when using cache", () => {
    const source = getSource();
    const fn = source.slice(
      source.indexOf("const fetchUserInfo"),
      source.indexOf("const fetchUserInfo") + 2000,
    );
    expect(fn).toContain("initializeAndFetchUserData(address.value).catch");
  });

  it("should not use cache during registration", () => {
    const source = getSource();
    const fn = source.slice(
      source.indexOf("const fetchUserInfo"),
      source.indexOf("const fetchUserInfo") + 1500,
    );
    expect(fn).toContain("!registrationPending.value");
  });
});
