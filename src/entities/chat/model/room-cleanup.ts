import type { LocalRoom } from "@/shared/lib/local-db";

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

/** Dependency injection interface for testability */
export interface CleanupContext {
  getAllRooms: () => Promise<LocalRoom[]>;
  deleteRooms: (ids: string[]) => Promise<void>;
  isRoomInSdk: (roomId: string) => boolean;
  getRoomHistoryVisibility: (roomId: string) => string | null;
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
      toRemove.push(room.id);
      continue;
    }
    const histVis = ctx.getRoomHistoryVisibility(room.id);
    if (histVis === "world_readable") {
      const lastActive = room.lastMessageTimestamp ?? room.updatedAt ?? 0;
      if (now - lastActive > THREE_DAYS_MS) {
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
