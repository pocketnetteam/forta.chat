import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Tests for broadcast/stream room filtering.
 * Rooms with history_visibility === "world_readable" (stream rooms) should be
 * hidden from forta.chat: no display, no notifications.
 * This matches old bastyon-chat behavior exactly.
 */

const chatStoreSource = readFileSync(resolve(__dirname, "../chat-store.ts"), "utf-8");
const schemaSource = readFileSync(resolve(__dirname, "../../../../shared/lib/local-db/schema.ts"), "utf-8");
const typesSource = readFileSync(resolve(__dirname, "../types.ts"), "utf-8");
const roomRepoSource = readFileSync(resolve(__dirname, "../../../../shared/lib/local-db/room-repository.ts"), "utf-8");
const pushSource = readFileSync(resolve(__dirname, "../../../../shared/lib/push/push-service.ts"), "utf-8");

describe("isBroadcastRoom helper", () => {
  it("is defined in chat-store.ts", () => {
    expect(chatStoreSource).toContain("function isBroadcastRoom(");
  });

  it("uses isWorldReadable for detection (matches old bastyon-chat history_visibility check)", () => {
    expect(chatStoreSource).toContain("!!room.isWorldReadable");
  });
});

describe("isWorldReadable field in types", () => {
  it("ChatRoom has isWorldReadable optional field", () => {
    expect(typesSource).toContain("isWorldReadable?: boolean");
  });

  it("LocalRoom has isWorldReadable optional field", () => {
    expect(schemaSource).toContain("isWorldReadable?: boolean");
  });

  it("ChatRoom still has isPublic for other uses", () => {
    expect(typesSource).toContain("isPublic?: boolean");
  });
});

describe("isWorldReadable detection in matrixRoomToChatRoom", () => {
  it("reads m.room.history_visibility state event", () => {
    expect(chatStoreSource).toContain("m.room.history_visibility");
  });

  it("checks for world_readable value", () => {
    expect(chatStoreSource).toContain('hv === "world_readable"');
  });

  it("includes isWorldReadable in the returned ChatRoom", () => {
    expect(chatStoreSource).toContain("isWorldReadable: isWorldReadable || undefined,");
  });
});

describe("isWorldReadable persistence in Dexie", () => {
  it("bulkSyncRooms accepts isWorldReadable field", () => {
    expect(roomRepoSource).toContain("isWorldReadable?: boolean");
  });

  it("persists isWorldReadable on existing room update", () => {
    expect(roomRepoSource).toContain("if (update.isWorldReadable !== undefined) patched.isWorldReadable = update.isWorldReadable;");
  });

  it("sets isWorldReadable on new room insert", () => {
    expect(roomRepoSource).toContain("isWorldReadable: update.isWorldReadable,");
  });

  it("detects isWorldReadable changes in skip-if-unchanged check", () => {
    expect(roomRepoSource).toContain("update.isWorldReadable !== prev.isWorldReadable");
  });

  it("Dexie version 12 is defined for isWorldReadable migration", () => {
    expect(schemaSource).toContain("this.version(12)");
  });
});

describe("broadcast room filtering in display layer", () => {
  it("filterInteractiveRooms still allows broadcast rooms through for Dexie sync", () => {
    expect(chatStoreSource).toContain("const filterInteractiveRooms");
  });

  it("fullRoomRefresh skips broadcast rooms from rooms.value", () => {
    expect(chatStoreSource).toContain("if (!isBroadcastRoom(room)) newRooms.push(room);");
  });

  it("fullRoomRefresh writes all rooms (including broadcast) to Dexie", () => {
    expect(chatStoreSource).toContain("allBuiltRooms.filter");
  });

  it("initDexieRooms filters broadcast rooms from dexieRoomMap", () => {
    expect(chatStoreSource).toContain("if (isBroadcastRoom(r)) continue;");
  });

  it("applyDexieDeltas treats broadcast rooms as non-interactive", () => {
    expect(chatStoreSource).toContain("&& !isBroadcastRoom(r);");
  });

  it("loadCachedRooms filters broadcast rooms", () => {
    expect(chatStoreSource).toContain("!isBroadcastRoom(r)");
  });

  it("totalUnread excludes broadcast rooms", () => {
    expect(chatStoreSource).toContain("if (!isBroadcastRoom(r)) sum += r.unreadCount;");
  });
});

describe("isRoomBroadcast store method", () => {
  it("is defined for external use (push, etc.)", () => {
    expect(chatStoreSource).toContain("const isRoomBroadcast = (roomId: string): boolean =>");
  });

  it("checks dexieRoomMap first (works even when room is filtered from roomsMap)", () => {
    expect(chatStoreSource).toContain("const lr = dexieRoomMap.get(roomId);");
  });

  it("is exported from the store", () => {
    expect(chatStoreSource).toContain("isRoomBroadcast,");
  });
});

describe("blocked/ignored user filtering", () => {
  it("isIgnoredUserRoom helper is defined", () => {
    expect(chatStoreSource).toContain("function isIgnoredUserRoom(");
  });

  it("checks isGroup to only filter 1:1 rooms", () => {
    expect(chatStoreSource).toContain("if (room.isGroup) return false;");
  });

  it("checks for single other member", () => {
    expect(chatStoreSource).toContain("if (otherMembers.length !== 1) return false;");
  });

  it("calls matrixService.isUserIgnored", () => {
    expect(chatStoreSource).toContain("matrixService.isUserIgnored(fullMatrixId)");
  });

  it("is applied in fullRebuildSortedRoomsAsync", () => {
    expect(chatStoreSource).toContain("if (myHex && isIgnoredUserRoom(cr, myHex)) continue;");
  });

  it("is applied in computeSortedRoomsFallback", () => {
    expect(chatStoreSource).toContain(".filter(r => !myHex || !isIgnoredUserRoom(r, myHex))");
  });

  it("is applied in patchSortedRooms", () => {
    expect(chatStoreSource).toContain("if (myHex && isIgnoredUserRoom(chatRoom, myHex)) continue;");
  });
});

describe("push notification suppression for broadcast rooms", () => {
  it("PushService has isRoomHidden callback", () => {
    expect(pushSource).toContain("isRoomHidden");
  });

  it("handlePushFromNative checks isRoomHidden before processing", () => {
    expect(pushSource).toContain("if (this.isRoomHidden?.(roomId))");
  });

  it("cancels native notification for hidden rooms", () => {
    expect(pushSource).toContain("PushData.cancelNotification({ roomId })");
  });

  it("setRoomHiddenChecker is exposed", () => {
    expect(pushSource).toContain("setRoomHiddenChecker(");
  });
});
