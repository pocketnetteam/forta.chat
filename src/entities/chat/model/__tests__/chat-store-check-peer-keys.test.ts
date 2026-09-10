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

  /**
   * Regression: checkPeerKeys() alone only reads canBeEncrypt(), which reads
   * the room crypto instance's ALREADY-CACHED users/usersinfo — it never
   * refetches. onMembership used to call checkPeerKeys() directly with no
   * prepare() first, so a member added to an already-prepared room's crypto
   * instance was silently and permanently excluded from the group common
   * key: usershash() kept hashing the OLD member set, so encryptEventGroup()
   * kept reusing the pre-existing common-key event that was never wrapped
   * for the new member (matrix-crypto.ts getOrCreateCommonKey/usershash).
   * The fix refreshes the room's crypto state (prepare()) BEFORE
   * checkPeerKeys so a membership change actually busts the stale cache.
   */
  it("refreshes the room's crypto state (prepare()) before re-checking peer keys", () => {
    const onMembershipIdx = storesSource.indexOf("onMembership:");
    expect(onMembershipIdx).toBeGreaterThan(-1);

    const blockEnd = storesSource.indexOf("onMyMembership", onMembershipIdx);
    const section = storesSource.slice(onMembershipIdx, blockEnd);

    expect(section).toMatch(/pcrypto\.value\?\.rooms\[roomId\]/);
    expect(section).toMatch(/roomCrypto\.prepare\(\)/);

    // Order matters: prepare() must run (and settle) before checkPeerKeys,
    // not just appear somewhere in the same handler.
    const prepareIdx = section.indexOf("roomCrypto.prepare()");
    const checkPeerKeysIdx = section.indexOf("checkPeerKeys(roomId)");
    expect(prepareIdx).toBeGreaterThan(-1);
    expect(checkPeerKeysIdx).toBeGreaterThan(prepareIdx);
    // The two calls must be chained (checkPeerKeys inside a .then()), not
    // fired concurrently — otherwise checkPeerKeys could still race ahead
    // and read the pre-refresh cache.
    expect(section.slice(prepareIdx, checkPeerKeysIdx)).toMatch(/\.then\(/);
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
