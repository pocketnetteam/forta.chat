import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression tests for the "stuck encryption-keys banner" bug.
 *
 * checkPeerKeys() was called once on activeRoomId change + a 30s setInterval.
 * It was NOT subscribed to RoomMember.membership events nor to
 * pcrypto.onKeysLoaded, so once the banner went up it stayed up until the
 * user manually switched chats — even after the peer published their keys.
 *
 * These tests pin the wiring in stores.ts: every member event AND every
 * onKeysLoaded callback must trigger a checkPeerKeys re-evaluation for the
 * affected room.
 */

const storesSource = readFileSync(
  resolve(__dirname, "../../../auth/model/stores.ts"),
  "utf-8",
);

describe("onKeysLoaded triggers peer-keys recheck", () => {
  it("calls chatStore.checkPeerKeys when pcrypto announces new keys", () => {
    // The onKeysLoaded callback must fan out to BOTH retryRoomDecryption
    // (already there) AND checkPeerKeys (the missing piece that left the
    // banner stuck on screen).
    const onKeysLoadedIdx = storesSource.indexOf("onKeysLoaded");
    expect(onKeysLoadedIdx).toBeGreaterThan(-1);

    // Find the assignment block, take ~600 chars of surrounding source.
    const section = storesSource.slice(onKeysLoadedIdx, onKeysLoadedIdx + 600);
    expect(section).toContain("checkPeerKeys");
  });
});

describe("onMembership triggers peer-keys recheck", () => {
  it("re-checks peer keys when a member event fires for that room", () => {
    const onMembershipIdx = storesSource.indexOf("onMembership:");
    expect(onMembershipIdx).toBeGreaterThan(-1);

    // Look at the body of the onMembership handler.
    const blockEnd = storesSource.indexOf("onMyMembership", onMembershipIdx);
    const section = storesSource.slice(onMembershipIdx, blockEnd);

    // Must invoke checkPeerKeys for the affected room — directly or via a
    // helper. We pin the substring so the wiring can't silently regress.
    expect(section).toContain("checkPeerKeys");
  });
});

describe("getUsersInfo log noise", () => {
  it("does not spam Sentry on the success path", () => {
    // Regression: the success path used to log `[getUsersInfo] id=… sdkPath=…`
    // through console.error, polluting Sentry / production logs and masking
    // real failures. Master removed the line entirely — pin that it stays gone.
    expect(storesSource).not.toMatch(/console\.\w+\([^)]*\[getUsersInfo\][^)]*sdkPath/);
  });
});
