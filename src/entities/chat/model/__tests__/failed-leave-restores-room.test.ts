import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { readFileSync } from "fs";
import { resolve } from "path";
import { ChatDatabase } from "@/shared/lib/local-db/schema";
import type { LocalRoom } from "@/shared/lib/local-db/schema";
import { RoomRepository } from "@/shared/lib/local-db/room-repository";
import { en } from "@/shared/lib/i18n/locales/en";
import { ru } from "@/shared/lib/i18n/locales/ru";

/**
 * Audit S7-01 / S7-04. "Leave group" and "Delete chat" tombstoned the room and
 * hid it, then logged a failed server leave and moved on: the SDK still counted
 * the user as joined, so the next sync quietly revived the tombstone and the
 * group came back with no explanation. The member menu likewise closed as if a
 * refused kick / ban / admin change had worked.
 *
 * chat-store needs the SDK to run, so its half is source-level like the other
 * chat-store contract tests; the repository half runs against Dexie.
 */

const store = readFileSync(resolve(__dirname, "../chat-store.ts"), "utf-8");
const panel = readFileSync(
  resolve(__dirname, "../../../../features/chat-info/ui/ChatInfoPanel.vue"),
  "utf-8",
);

function body(start: string): string {
  const a = store.indexOf(start);
  expect(a, `${start} not found`).toBeGreaterThan(-1);
  const b = store.indexOf("\n  };", a);
  return store.slice(a, b);
}

describe("a leave the server refused (audit S7-01)", () => {
  it("leaveGroup brings the room back and says so when the leave fails", () => {
    const leave = body("const leaveGroup = async");
    expect(leave).toContain('tombstoneForLeave(roomId, "left")');
    expect(leave).toMatch(
      /await matrixService\.leaveRoom\(roomId\);\s*\} catch \(e\) \{[\s\S]*return !\(await restoreRoomAfterFailedLeave\(roomId, previousMembership, "chat\.leaveFailed"\)\);/,
    );
    // A failed forget after a successful leave is not a failed leave.
    expect(leave).toMatch(/await matrixService\.forgetRoom\(roomId\);\s*\} catch/);
    expect(leave).toMatch(/return true;\s*$/);
  });

  it("removeRoom does the same with its own message", () => {
    const remove = body("const removeRoom = async");
    expect(remove).toContain('tombstoneForLeave(roomId, "removed")');
    expect(remove).toMatch(
      /await matrixService\.leaveRoom\(roomId\);\s*\} catch \(e\) \{[\s\S]*return !\(await restoreRoomAfterFailedLeave\(roomId, previousMembership, "chat\.deleteFailed"\)\);/,
    );
  });

  it("the restore revives the tombstone, refreshes the room and shows the error", () => {
    const restore = body("const restoreRoomAfterFailedLeave = async");
    // A leave whose answer was lost but that /sync already confirmed is not undone.
    expect(restore).toMatch(/if \(sdkSaysLeft\(roomId\)\) \{[\s\S]*?return false;/);
    expect(restore).toContain("rooms.reviveRoom(roomId, membership)");
    expect(restore).toContain("markRoomChanged(roomId);");
    expect(restore).toContain("refreshRooms();");
    expect(restore).toContain('useToast().toast(tRaw(messageKey), "error")');
  });

  it("has both messages in both locales", () => {
    for (const key of [
      "chat.leaveFailed",
      "chat.deleteFailed",
      "info.memberActionFailed",
      "chat.acceptInviteFailed",
      "chat.acceptInviteBanned",
    ] as const) {
      expect(en[key], key).toBeTruthy();
      expect(ru[key], key).toBeTruthy();
    }
  });
});

describe("member menu actions (audit S7-04)", () => {
  it("reports every refused member action instead of closing silently", () => {
    for (const call of [
      "chatStore.kickMember(",
      "chatStore.setMemberPowerLevel(",
      "chatStore.banMember(",
      "chatStore.muteMember(",
      "chatStore.unbanMember(",
    ]) {
      expect(panel, call).toContain(`reportMemberAction(await ${call}`);
    }
    expect(panel).toMatch(/if \(!ok\) showToast\(t\("info\.memberActionFailed"\), "error"\)/);
  });
});

describe("RoomRepository.reviveRoom", () => {
  let db: ChatDatabase;
  let repo: RoomRepository;

  const room = (overrides: Partial<LocalRoom> = {}): LocalRoom => ({
    id: "!g:s",
    name: "Group",
    isGroup: true,
    members: ["a", "b", "c"],
    membership: "join",
    unreadCount: 0,
    lastReadInboundTs: 0,
    lastReadOutboundTs: 0,
    updatedAt: Date.now(),
    syncedAt: Date.now(),
    hasMoreHistory: true,
    isDeleted: false,
    deletedAt: null,
    deleteReason: null,
    ...overrides,
  });

  beforeEach(async () => {
    db = new ChatDatabase(`test-failed-leave-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await db.open();
    repo = new RoomRepository(db);
  });

  afterEach(async () => {
    await db.delete();
  });

  it("puts back the membership the tombstone overwrote", async () => {
    await db.rooms.add(room());
    await repo.tombstoneRoom("!g:s", "left");
    expect((await db.rooms.get("!g:s"))?.membership).toBe("leave");

    await repo.reviveRoom("!g:s", "join");

    const revived = await db.rooms.get("!g:s");
    expect(revived?.isDeleted).toBe(false);
    expect(revived?.deleteReason).toBeNull();
    expect(revived?.membership).toBe("join");
    expect((await repo.getAllRooms()).map((r) => r.id)).toEqual(["!g:s"]);
  });

  it("leaves the membership alone when none is given", async () => {
    await db.rooms.add(room());
    await repo.tombstoneRoom("!g:s", "left");

    await repo.reviveRoom("!g:s");

    expect((await db.rooms.get("!g:s"))?.membership).toBe("leave");
  });
});
