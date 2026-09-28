import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression for the peer-keys "Retry" button / 30s auto-recheck contract.
 *
 * Bug: a peer's profile cached before they had keys stayed cached in-memory
 * (psdk.userInfo.load update:false) for the rest of the session — the
 * "Retry" button and the 30s auto-recheck both called roomCrypto.prepare()
 * with no way to bypass that cache, so neither could ever recover once the
 * peer actually published keys.
 *
 * Fix contract: the explicit "Retry" button forces a real network refetch
 * (prepare(true)); the automatic 30s recheck deliberately does NOT, so a
 * stuck room doesn't hammer the network every tick — see
 * matrix-crypto-force-refresh.test.ts for the callee-side half of this
 * contract (prepare(forceRefresh) → getusersinfo → getUsersInfoCb).
 *
 * "missing" is not always the peer: canBeEncrypt() also fails when THIS
 * account's own keys are not on the chain (audit W2A-01). The banner offers
 * "publish my keys" only in that case (authStore.ownKeysMissing, set by the
 * own-key check); for a peer without keys "Retry" stays the only action.
 *
 * Source verification — full-mount coverage of this component already
 * exists in ChatWindow.test.ts; that harness stubs pcrypto as null, so
 * asserting the exact call shape here is more direct than threading a fake
 * PcryptoRoomInstance through the module mock.
 */
const getSource = (): string =>
  readFileSync(resolve(__dirname, "../ChatWindow.vue"), "utf-8");

describe("ChatWindow peer-keys retry — forced vs automatic refresh", () => {
  it("retryPeerKeys (explicit user action) forces a fresh fetch: prepare(true)", () => {
    const source = getSource();
    const start = source.indexOf("const retryPeerKeys = async () => {");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n};", start);
    const section = source.slice(start, end);
    expect(section).toContain("await roomCrypto.prepare(true)");
  });

  it("offers publishing own keys only when this account's own keys are missing", () => {
    const source = getSource();
    expect(source).toMatch(/v-if="ownKeysMissing"[\s\S]{0,400}@click="publishOwnKeys"/);
    const start = source.indexOf("const publishOwnKeys = async () => {");
    expect(start).toBeGreaterThan(-1);
    expect(source.slice(start, source.indexOf("\n};", start))).toContain("authStore.republishKeysFromUi()");
    expect(source.split("republishKeysFromUi").length - 1).toBe(1);
  });

  // Audit S1-03: an unforced recheck never escapes a peer profile cached before
  // the peer published keys, so the banner stayed until the manual Retry. The
  // timer now forces one network refresh per room, then stays on the cache.
  it("the 30s auto-recheck forces one refresh per room, then stays on the cache", () => {
    const source = getSource();
    const timerStart = source.indexOf("peerKeyRecheckTimer = setInterval(async () => {");
    expect(timerStart).toBeGreaterThan(-1);
    const timerEnd = source.indexOf("}, 30_000);", timerStart);
    const section = source.slice(timerStart, timerEnd);
    expect(section).toContain("const force = !forcedPeerKeyRecheck.has(roomId);");
    expect(section).toContain("forcedPeerKeyRecheck.add(roomId);");
    expect(section).toContain("await roomCrypto.prepare(force);");
    expect(section).not.toContain("prepare(true)");
  });

  it("the 30s auto-recheck bails out while a forced retry is in flight", () => {
    // Regression: an unforced tick could resolve *after* a concurrent forced
    // retry and overwrite the freshly-fetched keys with the stale cached
    // read, reporting "missing" again right after the user was told it
    // worked. Guarding on the same in-flight flag the Retry button sets
    // closes that race without touching matrix-crypto's internals.
    const source = getSource();
    const timerStart = source.indexOf("peerKeyRecheckTimer = setInterval(async () => {");
    expect(timerStart).toBeGreaterThan(-1);
    const timerEnd = source.indexOf("}, 30_000);", timerStart);
    const section = source.slice(timerStart, timerEnd);
    const guardIdx = section.indexOf("if (peerKeysRetrying.value) return;");
    const statusIdx = section.indexOf('chatStore.peerKeysStatus.get(roomId)');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(statusIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(statusIdx);
  });
});
