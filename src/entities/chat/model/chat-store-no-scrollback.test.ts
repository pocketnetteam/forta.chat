import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const getSource = () => readFileSync(resolve(__dirname, "chat-store.ts"), "utf-8");

describe("fetchRoomPreview — no network scrollback", () => {
  it("should NOT call loadRoomMessages in fetchRoomPreview", () => {
    const source = getSource();
    const fn = source.slice(
      source.indexOf("const fetchRoomPreview"),
      source.indexOf("/** Drain the pending fetch queue"),
    );
    expect(fn).not.toContain("loadRoomMessages");
  });

  it("should still call loadCachedMessages for cache preload", () => {
    const source = getSource();
    const fn = source.slice(
      source.indexOf("const fetchRoomPreview"),
      source.indexOf("/** Drain the pending fetch queue"),
    );
    expect(fn).toContain("loadCachedMessages");
  });

  it("loadRoomMessages should still exist for active room use", () => {
    const source = getSource();
    expect(source).toContain("const loadRoomMessages");
    expect(source).toContain("loadRoomMessages(roomId, { waitForSdk: true })");
  });
});
