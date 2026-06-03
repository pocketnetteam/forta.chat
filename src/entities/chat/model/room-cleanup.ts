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
      toRemove.push(room.id);
      continue;
    }
    if (!ctx.isRoomInSdk(room.id)) {
      // DATA-LOSS GUARD (WEE-61): a recently-synced room may simply not be
      // materialized into SDK memory yet on a slow cold-start. Only treat it as
      // a genuine orphan if it hasn't synced for longer than the safety window.
      const syncedAt = room.syncedAt ?? 0;
      if (now - syncedAt < ORPHAN_SYNC_SAFETY_MS) {
        continue; // fresh — keep, SDK just hasn't loaded it yet
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
    console.log(`[room-cleanup] Removed ${toRemove.length} stale rooms`);
  }
  return toRemove.length;
}
