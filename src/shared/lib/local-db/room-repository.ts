import type { ChatDatabase, LocalRoom } from "./schema";
import type { MessageType } from "@/entities/chat/model/types";

export class RoomRepository {
  constructor(private db: ChatDatabase) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** Get all joined rooms sorted by last activity (newest first) */
  async getJoinedRooms(): Promise<LocalRoom[]> {
    const rooms = await this.db.rooms
      .where("membership")
      .equals("join")
      .toArray();
    return rooms.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Get invited rooms */
  async getInvitedRooms(): Promise<LocalRoom[]> {
    return this.db.rooms.where("membership").equals("invite").toArray();
  }

  /** Get all rooms (joined + invited), sorted by updatedAt desc */
  async getAllRooms(): Promise<LocalRoom[]> {
    const rooms = await this.db.rooms
      .where("membership")
      .anyOf(["join", "invite"])
      .toArray();
    return rooms.sort((a, b) => b.updatedAt - a.updatedAt);
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

  /** Update the last message preview for a room */
  async updateLastMessage(
    roomId: string,
    preview: string,
    timestamp: number,
    senderId: string,
    type?: MessageType,
    eventId?: string,
  ): Promise<void> {
    const changes: Partial<import("./schema").LocalRoom> = {
      lastMessagePreview: preview.slice(0, 200),
      lastMessageTimestamp: timestamp,
      lastMessageSenderId: senderId,
      lastMessageType: type,
      updatedAt: timestamp,
    };
    if (eventId !== undefined) {
      changes.lastMessageEventId = eventId;
    }
    console.log("[DELETE-DEBUG] updateLastMessage:", { roomId, preview: preview.slice(0, 30), timestamp });
    const updated = await this.db.rooms.update(roomId, changes);
    console.log("[DELETE-DEBUG] db.rooms.update result:", { updated, roomId });
    if (updated === 0) {
      // Room not yet in Dexie — check if it exists
      const existing = await this.db.rooms.get(roomId);
      console.log("[DELETE-DEBUG] room exists check:", { roomId, exists: !!existing, existingId: existing?.id });
      if (existing) {
        const updated2 = await this.db.rooms.update(roomId, changes);
        console.log("[DELETE-DEBUG] retry update result:", updated2);
      }
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

  /** Remove a room (leave/kick) */
  async removeRoom(roomId: string): Promise<void> {
    await this.db.transaction("rw", [this.db.rooms, this.db.messages], async () => {
      await this.db.rooms.delete(roomId);
      await this.db.messages.where("[roomId+timestamp]")
        .between([roomId, -Infinity], [roomId, Infinity])
        .delete();
    });
  }
}
