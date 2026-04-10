import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const getSource = () => readFileSync(resolve(__dirname, "chat-store.ts"), "utf-8");

describe("session guards — prevent redundant scrollback on room re-entry", () => {
  it("loadRoomMessages should skip scrollback when room is in _roomsWithLoadedTimeline", () => {
    const source = getSource();
    expect(source).toContain("const _roomsWithLoadedTimeline = new Set<string>()");
    // The scrollback loop is guarded by `!alreadyLoaded`
    expect(source).toContain("const alreadyLoaded = _roomsWithLoadedTimeline.has(roomId)");
    expect(source).toContain("if (!alreadyLoaded && msgCount < MIN_MESSAGES)");
  });

  it("loadRoomMessages should mark room as loaded after success", () => {
    const source = getSource();
    const fn = source.slice(
      source.indexOf("const loadRoomMessages"),
      source.indexOf("/** Load more (older) messages"),
    );
    expect(fn).toContain("_roomsWithLoadedTimeline.add(roomId)");
  });

  it("prefetchNextBatch should skip when room is in _roomsPrefetched", () => {
    const source = getSource();
    expect(source).toContain("const _roomsPrefetched = new Set<string>()");
    const fn = source.slice(
      source.indexOf("const prefetchNextBatch"),
      source.indexOf("/** Load ALL messages"),
    );
    expect(fn).toContain("if (_roomsPrefetched.has(roomId)) return true");
    expect(fn).toContain("_roomsPrefetched.add(roomId)");
  });

  it("clearTimelineSessionGuards clears both sets", () => {
    const source = getSource();
    expect(source).toContain("const clearTimelineSessionGuards = ()");
    const fn = source.slice(
      source.indexOf("const clearTimelineSessionGuards"),
      source.indexOf("/** Load timeline events"),
    );
    expect(fn).toContain("_roomsWithLoadedTimeline.clear()");
    expect(fn).toContain("_roomsPrefetched.clear()");
  });

  it("setSyncState clears guards on RECONNECTING or STOPPED", () => {
    const source = getSource();
    const fn = source.slice(
      source.indexOf("const setSyncState"),
      source.indexOf("/** Force immediate refresh"),
    );
    expect(fn).toContain("clearTimelineSessionGuards()");
    expect(fn).toContain(`state === "RECONNECTING" || state === "STOPPED"`);
  });

  it("refreshRooms clears guards on PREPARED (initial/full sync)", () => {
    const source = getSource();
    const fn = source.slice(
      source.indexOf("const refreshRooms"),
      source.indexOf("/** Update sync state"),
    );
    expect(fn).toContain(`if (state === "PREPARED") clearTimelineSessionGuards()`);
  });

  it("isRoomTimelineLoaded is exported for MessageList", () => {
    const source = getSource();
    expect(source).toContain("isRoomTimelineLoaded,");
    expect(source).toContain("clearTimelineSessionGuards,");
  });
});

describe("receipt dedup — prevent redundant /read_markers on room re-entry", () => {
  it("commitReadWatermark should skip server send when watermark hasn't advanced", () => {
    const source = getSource();
    expect(source).toContain("const _lastCommittedReceiptTs = new Map<string, number>()");
    const fn = source.slice(
      source.indexOf("const commitReadWatermark"),
      source.indexOf("/** Retry pending read watermarks"),
    );
    expect(fn).toContain("if (timestamp <= (_lastCommittedReceiptTs.get(roomId) ?? 0)) return");
  });

  it("commitReadWatermark should update _lastCommittedReceiptTs after successful send", () => {
    const source = getSource();
    const fn = source.slice(
      source.indexOf("const commitReadWatermark"),
      source.indexOf("/** Retry pending read watermarks"),
    );
    expect(fn).toContain("_lastCommittedReceiptTs.set(roomId, timestamp)");
  });

  it("flushPendingReadWatermarks should skip already-committed receipts", () => {
    const source = getSource();
    const fn = source.slice(
      source.indexOf("const flushPendingReadWatermarks"),
      source.indexOf("const setActiveRoom"),
    );
    expect(fn).toContain("if (timestamp <= (_lastCommittedReceiptTs.get(roomId) ?? 0))");
    expect(fn).toContain("_lastCommittedReceiptTs.set(roomId, timestamp)");
  });

  it("initReceiptWatermark seeds from Dexie lastReadInboundTs", () => {
    const source = getSource();
    expect(source).toContain("const initReceiptWatermark = async");
    const fn = source.slice(
      source.indexOf("const initReceiptWatermark"),
      source.indexOf("/** Atomically commit a read watermark"),
    );
    expect(fn).toContain("_lastCommittedReceiptTs.has(roomId)");
    expect(fn).toContain("room.lastReadInboundTs");
    expect(fn).toContain("_lastCommittedReceiptTs.set(roomId, room.lastReadInboundTs)");
  });

  it("setActiveRoom calls initReceiptWatermark", () => {
    const source = getSource();
    const fn = source.slice(
      source.indexOf("const setActiveRoom"),
      source.indexOf("/** Coalescing state for advanceInboundWatermark"),
    );
    expect(fn).toContain("initReceiptWatermark(roomId)");
  });
});
