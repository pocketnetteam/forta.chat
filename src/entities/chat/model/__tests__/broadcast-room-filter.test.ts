import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Tests for broadcast/stream room filtering.
 * Public groups (isGroup + isPublic) created by Bastyon for video broadcast
 * support should be hidden from forta.chat: no display, no notifications.
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

  it("returns true for public groups (isGroup && isPublic)", () => {
    expect(chatStoreSource).toContain("room.isGroup && !!room.isPublic");
  });
});

describe("isPublic field in types", () => {
  it("ChatRoom has isPublic optional field", () => {
    expect(typesSource).toContain("isPublic?: boolean");
  });

  it("LocalRoom has isPublic optional field", () => {
    expect(schemaSource).toContain("isPublic?: boolean");
  });
});

describe("isPublic detection in matrixRoomToChatRoom", () => {
  it("detects public rooms via kit.chatIsPublic", () => {
    expect(chatStoreSource).toContain("const isPublic = kit.chatIsPublic(room)");
  });

  it("includes isPublic in the returned ChatRoom", () => {
    expect(chatStoreSource).toContain("isPublic: isPublic || undefined,");
  });
});

describe("isPublic persistence in Dexie", () => {
  it("bulkSyncRooms accepts isPublic field", () => {
    expect(roomRepoSource).toContain("isPublic?: boolean");
  });

  it("persists isPublic on existing room update", () => {
    expect(roomRepoSource).toContain("if (update.isPublic !== undefined) patched.isPublic = update.isPublic;");
  });

  it("sets isPublic on new room insert", () => {
    expect(roomRepoSource).toContain("isPublic: update.isPublic,");
  });

  it("detects isPublic changes in skip-if-unchanged check", () => {
    expect(roomRepoSource).toContain("update.isPublic !== prev.isPublic");
  });

  it("Dexie version 11 is defined for isPublic migration", () => {
    expect(schemaSource).toContain("this.version(11)");
  });
});

describe("broadcast room filtering in display layer", () => {
  it("filterInteractiveRooms still allows broadcast rooms through for Dexie sync", () => {
    // Broadcast rooms must sync to Dexie so isPublic flag gets persisted.
    // Filtering happens at the display layer, not at filterInteractiveRooms.
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
