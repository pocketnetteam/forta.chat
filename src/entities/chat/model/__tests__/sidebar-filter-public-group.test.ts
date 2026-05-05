import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Pin tests for the sidebar `world_readable` filter (Session 28).
 *
 * The filter `isStreamHistoryVisibility` correctly excludes
 * broadcast/stream rooms (Bastyon channels) from the chat list. The Session
 * 28 fix touches the WRITE path in `setRoomPublic` (no longer producing
 * `world_readable` for public groups) — the READ-side filter logic stays
 * exactly as-is.
 *
 * These tests pin the filter wiring so a future refactor cannot
 * accidentally drop the broadcast-exclusion behavior, which would cause
 * Bastyon channels to flood the regular chat sidebar.
 */

const chatStoreSource = readFileSync(
  resolve(__dirname, "../chat-store.ts"),
  "utf-8",
);

describe("isStreamHistoryVisibility — pure check", () => {
  it("treats only world_readable as a stream marker", () => {
    // Locate the helper definition. It's a module-level function near the
    // top of chat-store.ts and the body is one return statement.
    const startIdx = chatStoreSource.indexOf(
      "function isStreamHistoryVisibility",
    );
    expect(startIdx).toBeGreaterThan(-1);
    // Slice through the body — a single-line return.
    const slice = chatStoreSource.slice(startIdx, startIdx + 200);
    expect(slice).toMatch(/return\s+hv\s*===\s*"world_readable"\s*;/);
  });
});

describe("shouldExcludeLocalRoomFromSidebar — applies stream filter first", () => {
  it("returns true for any room with world_readable historyVisibility", () => {
    const startIdx = chatStoreSource.indexOf(
      "shouldExcludeLocalRoomFromSidebar",
    );
    expect(startIdx).toBeGreaterThan(-1);
    // Find the actual function definition (skip the JSDoc-comment occurrence).
    const fnStart = chatStoreSource.indexOf(
      "const shouldExcludeLocalRoomFromSidebar",
    );
    expect(fnStart).toBeGreaterThan(-1);
    // Body bounded by the next top-level `// Outbound watermark...` comment.
    const fnEnd = chatStoreSource.indexOf(
      "// Outbound watermark for active room",
      fnStart,
    );
    expect(fnEnd).toBeGreaterThan(fnStart);
    const body = chatStoreSource.slice(fnStart, fnEnd);

    // Stream check is the very first guard — must be in the body.
    expect(body).toMatch(
      /isStreamHistoryVisibility\(lr\.historyVisibility[^)]*\)\)\s*return\s+true/s,
    );
  });
});

describe("Sync loops — skip stream rooms while iterating local-db rooms", () => {
  it("dexieRoomMap unread aggregation skips stream rooms", () => {
    // The aggregator at chat-store:1517-1518 uses `continue` on stream rooms
    // so their unread counts don't pollute the sidebar badge.
    const aggregatorIdx = chatStoreSource.indexOf("for (const r of dexieRoomMap.values())");
    expect(aggregatorIdx).toBeGreaterThan(-1);
    const slice = chatStoreSource.slice(aggregatorIdx, aggregatorIdx + 300);
    expect(slice).toMatch(/isStreamHistoryVisibility[^)]*\)\)\s*continue/s);
  });
});
