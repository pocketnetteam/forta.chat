import type { ChatDatabase, LocalRoom } from "./schema";
import type { MessageType } from "@/entities/chat/model/types";

export class RoomRepository {
  constructor(private db: ChatDatabase) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** Self-heal rooms with updatedAt=0 — use best available fallback timestamp */
  private healUpdatedAt(rooms: LocalRoom[]): LocalRoom[] {
    for (const r of rooms) {
      if (!r.updatedAt) {
        r.updatedAt = r.lastMessageTimestamp || r.syncedAt || 1;
      }
    }
    return rooms;
  }

  /** Sort key: prefer lastMessageTimestamp (actual message time),
   *  fall back to updatedAt for rooms with no messages yet */
  private sortKey(r: LocalRoom): number {
    return r.lastMessageTimestamp || r.updatedAt || 0;
  }

  /** Get all joined rooms sorted by last activity (newest first), excluding tombstones */
  async getJoinedRooms(): Promise<LocalRoom[]> {
    const rooms = await this.db.rooms
      .where("membership")
      .equals("join")
      .and(r => !r.isDeleted)
      .toArray();
    return this.healUpdatedAt(rooms).sort((a, b) => this.sortKey(b) - this.sortKey(a));
  }

  /** Get invited rooms, excluding tombstones */
  async getInvitedRooms(): Promise<LocalRoom[]> {
    return this.db.rooms.where("membership").equals("invite")
      .and(r => !r.isDeleted)
      .toArray();
  }

  /** Get all active rooms (joined + invited, non-tombstoned), sorted by last message time desc */
  async getAllRooms(): Promise<LocalRoom[]> {
    const rooms = await this.db.rooms
      .where("membership")
      .anyOf(["join", "invite"])
      .and(r => !r.isDeleted)
      .toArray();
    return this.healUpdatedAt(rooms).sort((a, b) => this.sortKey(b) - this.sortKey(a));
  }

  /** Get a single room by ID */
  async getRoom(roomId: string): Promise<LocalRoom | undefined> {
    return this.db.rooms.get(roomId);
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /** Upsert a single room */
  async upsertRoom(room: LocalRoom): Promise<void> {
    await this.db.rooms.put(room);
  }

  /** Bulk upsert rooms (after full sync) */
  async bulkUpsertRooms(rooms: LocalRoom[]): Promise<void> {
    await this.db.rooms.bulkPut(rooms);
  }

  /** Update specific fields on a room */
  async updateRoom(
    roomId: string,
    changes: Partial<LocalRoom>,
  ): Promise<void> {
    await this.db.rooms.update(roomId, changes);
  }

  /** Update the last message preview for a room.
   *  Monotonic: skips the update if the existing preview is already newer,
   *  preventing stale server data from overwriting fresher local-first writes. */
  async updateLastMessage(
    roomId: string,
    preview: string,
    timestamp: number,
    senderId: string,
    type?: MessageType,
    eventId?: string,
  ): Promise<void> {
    // Monotonic guard — never roll back to an older preview
    const existing = await this.db.rooms.get(roomId);
    if (existing?.lastMessageTimestamp && timestamp < existing.lastMessageTimestamp) {
      return;
    }

    const changes: Partial<import("./schema").LocalRoom> = {
      lastMessagePreview: preview.slice(0, 200),
      lastMessageTimestamp: timestamp,
      lastMessageSenderId: senderId,
      lastMessageType: type,
      updatedAt: Math.max(timestamp, existing?.updatedAt ?? 0),
      // New last message = clear old reaction (no double DB write)
      lastMessageReaction: null,
    };
    if (eventId !== undefined) {
      changes.lastMessageEventId = eventId;
    }
    const updated = await this.db.rooms.update(roomId, changes);
    if (updated === 0 && existing) {
      await this.db.rooms.update(roomId, changes);
    }
  }

  /** Update reaction on the last message (does NOT touch updatedAt) */
  async updateLastMessageReaction(
    roomId: string,
    reaction: import("./schema").LocalRoom["lastMessageReaction"],
  ): Promise<void> {
    await this.db.rooms.update(roomId, { lastMessageReaction: reaction });
  }

  /** Set unread count */
  async setUnreadCount(roomId: string, count: number): Promise<void> {
    await this.db.rooms.update(roomId, { unreadCount: count });
  }

  /** Update outbound read watermark (other party read our messages up to this timestamp) */
  async updateOutboundWatermark(roomId: string, timestamp: number): Promise<void> {
    const room = await this.getRoom(roomId);
    if (!room) return;
    // Watermark only moves forward (monotonic)
    if (timestamp <= (room.lastReadOutboundTs ?? 0)) return;
    await this.db.rooms.update(roomId, { lastReadOutboundTs: timestamp });
  }

  /** Update inbound read watermark + clear unread (we read messages up to this timestamp) */
  async markAsRead(roomId: string, timestamp: number): Promise<void> {
    const room = await this.getRoom(roomId);
    if (!room) return;
    if (timestamp <= (room.lastReadInboundTs ?? 0)) return;
    await this.db.rooms.update(roomId, {
      lastReadInboundTs: timestamp,
      unreadCount: 0,
    });
  }

  /** Update pagination token for a room */
  async setPaginationToken(
    roomId: string,
    token: string | undefined,
    hasMore: boolean,
  ): Promise<void> {
    await this.db.rooms.update(roomId, {
      paginationToken: token,
      hasMoreHistory: hasMore,
    });
  }

  /** Mark room as synced */
  async markSynced(roomId: string): Promise<void> {
    await this.db.rooms.update(roomId, { syncedAt: Date.now() });
  }

  /** Remove a room (leave/kick) — physical delete */
  async removeRoom(roomId: string): Promise<void> {
    await this.db.transaction("rw", [this.db.rooms, this.db.messages], async () => {
      await this.db.rooms.delete(roomId);
      await this.db.messages.where("[roomId+timestamp]")
        .between([roomId, -Infinity], [roomId, Infinity])
        .delete();
    });
  }

  // ---------------------------------------------------------------------------
  // Tombstone (soft-delete for cross-device sync)
  // ---------------------------------------------------------------------------

  /** Soft-delete a room: mark as tombstone so it's hidden from UI but remains
   *  in Dexie for sync purposes. Cross-device sync relies on this — when Device B
   *  receives a membership=leave event, it tombstones the room instead of hard-deleting. */
  async tombstoneRoom(
    roomId: string,
    reason: "left" | "kicked" | "banned" | "removed",
  ): Promise<void> {
    const updated = await this.db.rooms.update(roomId, {
      isDeleted: true,
      deletedAt: Date.now(),
      deleteReason: reason,
      membership: "leave" as const,
    });
    // Room may not exist in Dexie yet (e.g. never synced to this device)
    if (updated === 0) {
      console.warn(`[RoomRepo] tombstoneRoom: room ${roomId} not found in Dexie`);
    }
  }

  /** Revive a tombstoned room (e.g. user re-joined the room) */
  async reviveRoom(roomId: string): Promise<void> {
    await this.db.rooms.update(roomId, {
      isDeleted: false,
      deletedAt: null,
      deleteReason: null,
    });
  }

  /** Check if a room is tombstoned */
  async isTombstoned(roomId: string): Promise<boolean> {
    const room = await this.db.rooms.get(roomId);
    return room?.isDeleted === true;
  }

  /** Garbage-collect tombstoned rooms older than ttlMs (default 30 days).
   *  Physically removes the room and all its messages from Dexie. */
  async garbageCollectTombstones(ttlMs: number = 30 * 24 * 60 * 60 * 1000): Promise<number> {
    const cutoff = Date.now() - ttlMs;
    const staleRooms = await this.db.rooms
      .where("isDeleted")
      .equals(1) // Dexie stores booleans as 0/1 in indexes
      .and(r => r.deletedAt !== null && r.deletedAt < cutoff)
      .toArray();

    if (staleRooms.length === 0) return 0;

    await this.db.transaction("rw", [this.db.rooms, this.db.messages], async () => {
      for (const room of staleRooms) {
        await this.db.messages.where("[roomId+timestamp]")
          .between([room.id, -Infinity], [room.id, Infinity])
          .delete();
        await this.db.rooms.delete(room.id);
      }
    });

    console.log(`[RoomRepo] GC: cleaned ${staleRooms.length} tombstoned rooms`);
    return staleRooms.length;
  }
}
