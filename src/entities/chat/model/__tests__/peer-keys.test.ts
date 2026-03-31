import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("peer key status tracking", () => {
  it("chat-store should expose peerKeysStatus and checkPeerKeys", () => {
    const source = readFileSync(resolve(__dirname, "../chat-store.ts"), "utf-8");
    expect(source).toContain("peerKeysStatus");
    expect(source).toContain("checkPeerKeys");
  });

  it("types should define PeerKeysStatus type", () => {
    const source = readFileSync(resolve(__dirname, "../types.ts"), "utf-8");
    expect(source).toContain("PeerKeysStatus");
  });

  it("cleanup should clear peerKeysStatus", () => {
    const source = readFileSync(resolve(__dirname, "../chat-store.ts"), "utf-8");
    expect(source).toContain("peerKeysStatus.clear()");
  });
});
