import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression: lazyLoadMembers left member state (m.room.member) for a
 * freshly-created 1:1 chat unresolved locally until the peer sent a first
 * message. getusershistory() in matrix-crypto.ts only reads locally-synced
 * member state, so canBeEncrypt() saw an incomplete `usersinfo` (just the
 * local user) and reported the peer as missing encryption keys even though
 * they had published them — a pure client-side race, unrelated to whether
 * the peer's keys were actually on-chain.
 *
 * Fix: disable lazy loading in both the sync filter and startClient() so
 * full member state (including m.room.member) always arrives with /sync.
 */
const getSource = (): string =>
  readFileSync(resolve(__dirname, "../matrix-client.ts"), "utf-8");

describe("matrix-client sync config — lazy member loading disabled", () => {
  it("the sync filter requests full (non-lazy) member state", () => {
    const source = getSource();
    // Both filter sections (timeline + state) must be false — a stray
    // leftover `true` would silently reintroduce the incomplete-members race.
    const matches = source.match(/lazy_load_members:\s*(true|false)/g) ?? [];
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      expect(m).toBe("lazy_load_members: false");
    }
  });

  it("startClient() disables lazyLoadMembers", () => {
    const source = getSource();
    expect(source).toMatch(/lazyLoadMembers:\s*false/);
    expect(source).not.toMatch(/lazyLoadMembers:\s*true/);
  });
});
