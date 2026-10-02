import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression: a reaction on a room's last message reached `chatStore.sortedRooms` but not the
 * chat list row. ContactList keeps its own per-room item cache and compared only timestamp,
 * status, content, sender and a few room fields, so a last message rewritten in place (a
 * reaction added, a hangup that turned missed) kept returning the old row. The list mounts
 * RecycleScroller and half the stores, so this checks the cache's source instead.
 */
const source = readFileSync(resolve(__dirname, "ContactList.vue"), "utf-8");

describe("ContactList row cache", () => {
  it("imports the last-message row key", () => {
    expect(source).toMatch(/import \{ lastMessageRowKey \} from "@\/features\/contacts\/lib\/last-message-row-key";/);
  });

  it("compares and stores the key for every room row", () => {
    const start = source.indexOf("const filteredRooms = computed");
    const end = source.indexOf("return allFilteredRooms.value", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const toItem = source.slice(start, end);
    expect(toItem).toContain("const lastMessageKey = lastMessageRowKey(r);");
    expect(toItem).toContain("cached.lastMessageKey === lastMessageKey");
    expect(toItem).toMatch(/_unifiedItemCache\.set\(r\.id, \{[^}]*lastMessageKey[^}]*item \}\)/);
  });

  // Perf: the invites tab holds thousands of rooms; a row (spread + title) per room on
  // every list change made each mounted tab's setup take ~150 ms on cold start.
  it("builds rows only for the displayed page, not for every room of the tab", () => {
    const start = source.indexOf("const allFilteredRooms = computed");
    const end = source.indexOf("const filteredRooms = computed", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const all = source.slice(start, end);
    expect(all).not.toContain("toItem");
    expect(all).not.toContain("getRoomTitle");
    const page = source.slice(end, source.indexOf("// RecycleScroller gets the same array", end));
    expect(page).toMatch(/allFilteredRooms\.value\s*\.slice\(0, displayLimit\.value\)\s*\.map\(/);
  });

  // Perf: every mounted tab built its own name index over all rooms (4× the same work).
  it("reads room names from the shared store instead of building its own index", () => {
    expect(source).toContain("const roomNameIndex = computed(() => roomNamesStore.roomNameIndex);");
    expect(source).not.toContain("createRoomNameIndex");
  });
});
