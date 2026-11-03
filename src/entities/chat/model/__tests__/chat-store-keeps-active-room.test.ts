import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

/**
 * Audit S3b-01 / forta-bugs#1390: "I open a chat and inside it says 'select a
 * chat to start'". incrementalRoomRefresh dropped any changed room that
 * getRoom() did not return — including rooms the SDK has not materialised yet
 * and every room while the client is rebuilt — so the open room left roomsMap,
 * chatStore.activeRoom became undefined and ChatWindow showed its empty state
 * while the sidebar still had the chat selected. fullRoomRefresh already kept
 * the active room; the incremental path now does too.
 *
 * Source-level, like the other chat-store refresh tests: the store needs the
 * SDK, Dexie and Pinia wiring to run a refresh.
 */
const source = readFileSync(resolve(__dirname, "../chat-store.ts"), "utf-8");

describe("incrementalRoomRefresh keeps the open room (audit S3b-01)", () => {
  it("skips removal for the active room before deleting anything", () => {
    const start = source.indexOf("const incrementalRoomRefresh = (");
    expect(start).toBeGreaterThan(-1);
    const missingBranch = source.slice(start, source.indexOf("continue;\n      }", start));
    const keep = missingBranch.indexOf("if (roomId === activeRoomId.value) continue;");
    const remove = missingBranch.indexOf("roomsMap.delete(roomId)");
    expect(keep).toBeGreaterThan(-1);
    expect(remove).toBeGreaterThan(keep);
  });

  it("matches fullRoomRefresh, which already keeps the previous active room", () => {
    expect(source).toMatch(/if \(prevActiveRoom && !newRooms\.some\(r => r\.id === prevActiveRoom\.id\)\) \{\s*newRooms\.push\(prevActiveRoom\);/);
  });
});
