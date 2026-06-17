import type { LocalRoom } from "@/shared/lib/local-db";

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Safety window for orphan removal (WEE-61 / forta-bugs#892 — DATA LOSS).
 *
 * `isRoomInSdk` returning false is NOT reliable evidence of an orphan shortly
 * after a cold-start/update: matrix-js-sdk lazily materializes Room objects, so
 * on slow WebView / 50+ rooms `getRoom()` returns null for rooms that are still
 * valid and just haven't loaded yet. A room synced within this window is
 * therefore kept even if absent from SDK memory. Genuinely-left rooms come
 * through the `membership === "leave"` branch and are unaffected.
 */
export const ORPHAN_SYNC_SAFETY_MS = 24 * 60 * 60 * 1000;

/**
 * Safety window for the `membership === "leave"` branch (WEE-84 — DATA LOSS).
 *
 * A room whose membership reads "leave" is NOT always a genuine leave: on a slow
 * sync / channel outside the Matrix SDK / partial room-member event the field can
 * be stale or never-materialized. A room with a *recent message* is an active
 * conversation the user just used ("opened → wrote → left → re-entered") and must
 * never be tombstoned by the leave branch. Only confirmed-leave AND inactive
 * rooms are removed. Uses `lastMessageTimestamp` exclusively (not `updatedAt`,
 * which Dexie bumps on every metadata write) so the guard tracks real activity.
 */
export const ACTIVE_ROOM_SAFETY_MS = 24 * 60 * 60 * 1000;

/** Verdict for an on-open zombie-room check. */
export type RoomHealthVerdict =
  | { action: "keep" }
  | { action: "tombstone"; reason: "left" | "banned" };

/**
 * Decide whether a room the user just opened is a genuine zombie (left/banned on
 * another device) or simply not-yet-materialized by the SDK (WEE-84).
 *
 * Critically, neither a missing SDK room nor an `undefined` membership is proof
 * of a zombie: matrix-js-sdk lazily materializes Room objects (slow WebView /
 * 50+ rooms) and channels (`world_readable` broadcast) may live outside the SDK
 * entirely. Defaulting either case to "leave" → tombstone removed freshly-opened
 * chats/channels on re-entry. Only an EXPLICIT "leave"/"ban" self-membership is
 * treated as a zombie; everything else is kept (genuine orphans are still GC'd
 * later by `cleanupStaleRooms` with its 24h sync safety window).
 */
export function classifyOpenedRoomHealth(
  roomInSdk: boolean,
  selfMembership: string | undefined | null,
): RoomHealthVerdict {
  if (!roomInSdk) return { action: "keep" };
  if (selfMembership === "leave") return { action: "tombstone", reason: "left" };
  if (selfMembership === "ban") return { action: "tombstone", reason: "banned" };
  return { action: "keep" };
}

/** Dependency injection interface for testability */
export interface CleanupContext {
  getAllRooms: () => Promise<LocalRoom[]>;
  deleteRooms: (ids: string[]) => Promise<void>;
  isRoomInSdk: (roomId: string) => boolean;
  getRoomHistoryVisibility: (roomId: string) => string | null;
  /** Matrix leave + forget for stale stream rooms (bastyon-chat parity). Optional — tests omit. */
  leaveForgetStreamRoom?: (roomId: string) => Promise<void>;
}

/**
 * Remove stale rooms from Dexie:
 * 1. Rooms with membership="leave"
 * 2. Orphaned rooms (in Dexie but not in Matrix SDK)
 * 3. Stream rooms (world_readable) with no activity for >3 days
 */
export async function cleanupStaleRooms(ctx: CleanupContext): Promise<number> {
  const allRooms = await ctx.getAllRooms();
  const now = Date.now();
  const toRemove: string[] = [];

  for (const room of allRooms) {
    if (room.membership === "leave") {
      // DATA-LOSS GUARD (WEE-84): an active room (just opened / fresh message)
      // must survive even if membership reads "leave" — the field can be stale
      // or unmaterialized on slow sync. Tombstone only confirmed-leave AND
      // inactive rooms. `updatedAt` is intentionally NOT consulted (Dexie bumps
      // it on metadata writes); only a real message keeps the room alive.
      const lastMessageTs = room.lastMessageTimestamp ?? 0;
      if (now - lastMessageTs < ACTIVE_ROOM_SAFETY_MS) {
        continue; // recently active — keep
      }
      toRemove.push(room.id);
      continue;
    }
    if (!ctx.isRoomInSdk(room.id)) {
      // DATA-LOSS GUARD (WEE-61 + WEE-65): a recently-synced room may simply not
      // be materialized into SDK memory yet on a slow cold-start. Only treat it
      // as a genuine orphan if it hasn't synced for longer than the safety
      // window.
      //
      // WEE-65 — NEW-DEVICE DATA LOSS: on a fresh install / reinstall every room
      // lands in Dexie with `syncedAt = undefined` *before* the first sync
      // materializes it into the SDK. The previous `syncedAt ?? 0` collapsed
      // that to epoch 0, so `now - 0` always exceeded the window and valid
      // never-synced rooms (= contacts) were tombstoned before the first sync
      // could claim them. A never-synced room is therefore kept unconditionally;
      // it is only ever removed once it HAS a syncedAt older than the window
      // (i.e. it was synced before and has since gone genuinely orphaned).
      if (!room.syncedAt || now - room.syncedAt < ORPHAN_SYNC_SAFETY_MS) {
        continue; // never-synced (new device) or fresh — keep
      }
      toRemove.push(room.id);
      continue;
    }
    const histVis = ctx.getRoomHistoryVisibility(room.id);
    if (histVis === "world_readable") {
      const lastActive = room.lastMessageTimestamp ?? room.updatedAt ?? 0;
      if (now - lastActive > THREE_DAYS_MS) {
        if (ctx.leaveForgetStreamRoom) {
          try {
            await ctx.leaveForgetStreamRoom(room.id);
          } catch {
            continue;
          }
        }
        toRemove.push(room.id);
        continue;
      }
    }
  }

  if (toRemove.length > 0) {
    await ctx.deleteRooms(toRemove);
    console.info(`[room-cleanup] Removed ${toRemove.length} stale rooms`);
  }
  return toRemove.length;
}
