import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression for the peer-keys "Retry" button being a silent no-op.
 *
 * Bug: once a peer's profile was cached in-memory by the vendored Pocketnet
 * SDK (psdk.userInfo.load with update:false), every later key-resolution call
 * — including the explicit "Retry" button in ChatWindow.vue and the 30s
 * auto-recheck — read that same cache and never hit the network again for the
 * rest of the session. A peer who published keys *after* the first (stale)
 * lookup stayed permanently reported as "missing" until app restart.
 *
 * Fix: thread an explicit `forceRefresh` flag from prepare() down to
 * getusersinfo() → pcrypto.getUsersInfoCb(us, { forceUpdate }) → the SDK's
 * loadUsersInfo({ update: true }), bypassing the cache. Only the explicit
 * retry path sets it — automatic rechecks must stay on the cache to avoid
 * hammering the network on every tick (see peer-keys-retry-force.test.ts for
 * the caller-side half of this contract).
 *
 * Source verification — the actual crypto module pulls in miscreant +
 * WebCrypto and is impractical to unit-test without an extensive harness
 * (same rationale as the other matrix-crypto regression tests here).
 */
const getSource = (): string =>
  readFileSync(resolve(__dirname, "../matrix-crypto.ts"), "utf-8");

describe("matrix-crypto force-refresh wiring for peer-keys retry", () => {
  it("PcryptoRoomInstance.prepare() accepts a forceRefresh flag", () => {
    const source = getSource();
    expect(source).toMatch(/prepare\(forceRefresh\?:\s*boolean\)/);
  });

  it("room.prepare(forceRefresh) passes it through to getusersinfo(forceRefresh)", () => {
    const source = getSource();
    const start = source.indexOf("async prepare(forceRefresh?: boolean): Promise<PcryptoRoomInstance> {");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n      },", start);
    const section = source.slice(start, end);
    expect(section).toContain("await getusersinfo(forceRefresh)");
  });

  it("getusersinfo(forceRefresh) forwards it as { forceUpdate } to getUsersInfoCb", () => {
    const source = getSource();
    const start = source.indexOf("async function getusersinfo(forceRefresh?: boolean): Promise<void> {");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n    }", start);
    const section = source.slice(start, end);
    expect(section).toContain("pcrypto.getUsersInfoCb(us, { forceUpdate: forceRefresh })");
  });

  it("Pcrypto.addRoom(chat, forceRefresh) forwards it for both new and existing rooms", () => {
    const source = getSource();
    const start = source.indexOf("async addRoom(chat: Record<string, unknown>, forceRefresh?: boolean)");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n  }", start);
    const section = source.slice(start, end);
    // Existing-room branch
    expect(section).toContain("this.rooms[roomId].prepare(forceRefresh)");
    // New-room branch
    expect(section).toContain("room.prepare(forceRefresh)");
  });
});

describe("matrix-crypto getusersinfo — stale-response guard (race between forced + unforced calls)", () => {
  // Regression: the 30s auto-recheck (unforced) and an explicit forced
  // Retry/Republish can both be in flight at once — both read/write the same
  // room-closure `usersinfo`. Without ordering, whichever network call
  // happens to resolve LAST wins, even if it was the older, stale (cached)
  // one — silently clobbering the freshly-fetched keys the forced call just
  // wrote, so canBeEncrypt() flips back to "missing" right after the user
  // was told the retry worked.
  it("increments a generation counter per getusersinfo() call", () => {
    const source = getSource();
    expect(source).toMatch(/let usersinfoGeneration = 0;/);
    const start = source.indexOf("async function getusersinfo(forceRefresh?: boolean): Promise<void> {");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n    }", start);
    const section = source.slice(start, end);
    expect(section).toContain("const myGeneration = ++usersinfoGeneration;");
  });

  it("discards the response and skips the usersinfo write if a newer call has since started", () => {
    const source = getSource();
    const start = source.indexOf("async function getusersinfo(forceRefresh?: boolean): Promise<void> {");
    const end = source.indexOf("\n    }", start);
    const section = source.slice(start, end);
    const guardIdx = section.indexOf("if (myGeneration !== usersinfoGeneration) return;");
    const writeIdx = section.indexOf("usersinfo = {};");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(-1);
    // Guard must run BEFORE the write it protects.
    expect(guardIdx).toBeLessThan(writeIdx);
  });
});
