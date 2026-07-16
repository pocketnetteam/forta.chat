import { describe, it, expect } from "vitest";
import {
  resolveKeyRepublishAction,
  countCachedKeys,
  countPublishedKeys,
  REQUIRED_ENCRYPTION_KEYS,
  type KeyRepublishInput,
} from "../key-republish";

const base: KeyRepublishInput = {
  cachedKeyCount: 0,
  blockchainKeyCount: null,
  blockchainCheckFailed: false,
  hasUnspents: false,
};

describe("resolveKeyRepublishAction", () => {
  it("returns keys-ok from cache when the cache already has 12 keys", () => {
    const action = resolveKeyRepublishAction({ ...base, cachedKeyCount: 12 });
    expect(action).toEqual({ kind: "keys-ok", source: "cache", keyCount: 12 });
  });

  it("returns keys-ok from blockchain when cache is stale but chain confirms keys", () => {
    const action = resolveKeyRepublishAction({
      ...base,
      cachedKeyCount: 0,
      blockchainKeyCount: 12,
    });
    expect(action).toEqual({ kind: "keys-ok", source: "blockchain", keyCount: 12 });
  });

  it("returns rpc-failed (does not block login) when the blockchain check threw", () => {
    const action = resolveKeyRepublishAction({
      ...base,
      cachedKeyCount: 0,
      blockchainCheckFailed: true,
      // even if funds exist, an inconclusive check must not trigger a republish
      hasUnspents: true,
    });
    expect(action).toEqual({ kind: "rpc-failed" });
  });

  it("returns republish when keys are missing and the account is funded", () => {
    const action = resolveKeyRepublishAction({
      ...base,
      cachedKeyCount: 0,
      blockchainKeyCount: 0,
      hasUnspents: true,
    });
    expect(action).toEqual({ kind: "republish" });
  });

  it("returns needs-funds when keys are missing and there is no PKOIN", () => {
    const action = resolveKeyRepublishAction({
      ...base,
      cachedKeyCount: 0,
      blockchainKeyCount: 0,
      hasUnspents: false,
    });
    expect(action).toEqual({ kind: "needs-funds" });
  });

  it("treats a partial key set (< 12) as missing", () => {
    const action = resolveKeyRepublishAction({
      ...base,
      cachedKeyCount: 5,
      blockchainKeyCount: 5,
      hasUnspents: true,
    });
    expect(action).toEqual({ kind: "republish" });
  });

  // ── WEE-35 / forta-bugs#520 regression invariant ──
  // The login-time key check runs for an ALREADY-AUTHENTICATED account. No
  // outcome may ever drive the registration UI ("Подготовка аккаунта"), which
  // hung existing-account login (especially Bastyon-registered accounts and
  // transient empty-keys RPC responses).
  describe("never mounts the registration stepper for an existing account", () => {
    const scenarios: Array<[string, KeyRepublishInput]> = [
      [
        "Bastyon-registered account: chain has a profile but 0 Forta keys, funded",
        { cachedKeyCount: 0, blockchainKeyCount: 0, blockchainCheckFailed: false, hasUnspents: true },
      ],
      [
        "Bastyon-registered account: 0 Forta keys, no PKOIN",
        { cachedKeyCount: 0, blockchainKeyCount: 0, blockchainCheckFailed: false, hasUnspents: false },
      ],
      [
        "transient empty-keys RPC response (chain reports null)",
        { cachedKeyCount: 0, blockchainKeyCount: null, blockchainCheckFailed: false, hasUnspents: false },
      ],
      [
        "RPC check failed entirely",
        { cachedKeyCount: 0, blockchainKeyCount: null, blockchainCheckFailed: true, hasUnspents: true },
      ],
    ];

    it.each(scenarios)("%s → background/no-op, not registration", (_label, input) => {
      const action = resolveKeyRepublishAction(input);
      // The action union has no "register"/"pending" member by construction;
      // assert the resolved kind is one of the four safe outcomes.
      expect(["keys-ok", "rpc-failed", "needs-funds", "republish"]).toContain(action.kind);
    });
  });

  it("exposes the required key count as 12", () => {
    expect(REQUIRED_ENCRYPTION_KEYS).toBe(12);
  });
});

describe("countCachedKeys", () => {
  it("counts a populated keys array", () => {
    expect(countCachedKeys({ keys: ["a", "b", "c"] })).toBe(3);
  });
  it("ignores falsy entries", () => {
    expect(countCachedKeys({ keys: ["a", "", null, "b"] })).toBe(2);
  });
  it("returns 0 for missing/empty/non-array shapes", () => {
    expect(countCachedKeys(null)).toBe(0);
    expect(countCachedKeys(undefined)).toBe(0);
    expect(countCachedKeys({})).toBe(0);
    expect(countCachedKeys({ keys: "not-an-array" })).toBe(0);
  });
});

describe("countPublishedKeys", () => {
  it("counts an array under `k`", () => {
    expect(countPublishedKeys({ k: ["a", "b"] })).toBe(2);
  });
  it("counts a comma-separated string under `k`", () => {
    expect(countPublishedKeys({ k: "a,b,c" })).toBe(3);
  });
  it("falls back to legacy `keys` field", () => {
    expect(countPublishedKeys({ keys: "a,b" })).toBe(2);
  });
  it("filters empty segments in a string", () => {
    expect(countPublishedKeys({ k: "a,,b," })).toBe(2);
  });
  it("returns 0 for null/empty/non-object", () => {
    expect(countPublishedKeys(null)).toBe(0);
    expect(countPublishedKeys(undefined)).toBe(0);
    expect(countPublishedKeys("string")).toBe(0);
    expect(countPublishedKeys({ k: "" })).toBe(0);
    expect(countPublishedKeys({})).toBe(0);
  });
});
