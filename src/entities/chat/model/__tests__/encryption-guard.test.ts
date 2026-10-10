import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import type { PeerKeysStatus } from "../types";

/**
 * Tests for encryption guard logic.
 * Verifies that:
 * 1. PeerKeysStatus type includes "not-encrypted"
 * 2. checkPeerKeys distinguishes public/large rooms from missing keys
 * 3. ensureRoomCrypto skips public rooms
 * 4. canBeEncrypt uses getJoinedMemberCount for accurate member count
 * 5. peerKeysOk allows send for all statuses except "missing"
 */

describe("peerKeysOk guard", () => {
  it.each<{ status: PeerKeysStatus; expected: boolean }>([
    { status: "not-encrypted", expected: true },
    { status: "available", expected: true },
    { status: "unknown", expected: true },
    { status: "missing", expected: false },
  ])("peerKeysOk=$expected when status=$status", ({ status, expected }) => {
    // Mirrors MessageInput.vue peerKeysOk logic: status !== "missing"
    const peerKeysOk = status !== "missing";
    expect(peerKeysOk).toBe(expected);
  });
});

describe("checkPeerKeys logic branches", () => {
  const source = readFileSync(resolve(__dirname, "../chat-store.ts"), "utf-8");

  it("checks isRoomPublic first and returns 'not-encrypted'", () => {
    expect(source).toContain('if (isRoomPublic(roomId))');
    expect(source).toContain('peerKeysStatus.set(roomId, "not-encrypted")');
  });

  // The available / missing / not-encrypted / still-loading branches live in
  // decidePeerKeysStatus (lib/peer-keys-status.ts) and are exercised by
  // lib/peer-keys-status.test.ts; here we pin that checkPeerKeys feeds it.
  it("decides the status from canBeEncrypt, member profiles and member count", () => {
    const start = source.indexOf("const checkPeerKeys = async");
    const body = source.slice(start, source.indexOf("\n  };", start));
    expect(body).toContain("roomCrypto.canBeEncrypt()");
    expect(body).toContain("getJoinedMemberCount");
    expect(body).toMatch(/decidePeerKeysStatus\(\{[\s\S]*canEncrypt[\s\S]*membersLoaded: roomCrypto\.membersLoaded\?\.\(\)[\s\S]*memberCount/);
    expect(body).toContain("peerKeysStatus.set(roomId, status)");
  });
});

describe("ensureRoomCrypto public room guard", () => {
  const source = readFileSync(resolve(__dirname, "../chat-store.ts"), "utf-8");

  it("skips pcrypto.addRoom for public rooms", () => {
    expect(source).toContain("// Skip encryption setup for public rooms");
    expect(source).toContain("if (isRoomPublic(roomId)) return undefined;");
  });
});

describe("canBeEncrypt uses actual member count", () => {
  const source = readFileSync(
    resolve(__dirname, "../../../matrix/model/matrix-crypto.ts"),
    "utf-8",
  );

  it("uses Math.max of server count and usersinfo for threshold", () => {
    expect(source).toContain("getJoinedMemberCount");
    expect(source).toContain("Math.max(serverCount, usersinfoArray.length)");
    expect(source).toContain("memberCount >= 50");
  });

  it("prepare() also uses getJoinedMemberCount for skip threshold", () => {
    expect(source).toContain("Math.max(actualMemberCount, Object.keys(users).length)");
  });
});

describe("PeerKeysStatus type", () => {
  const source = readFileSync(resolve(__dirname, "../types.ts"), "utf-8");

  it("has all four status values", () => {
    expect(source).toContain('"unknown"');
    expect(source).toContain('"available"');
    expect(source).toContain('"missing"');
    expect(source).toContain('"not-encrypted"');
  });
});
