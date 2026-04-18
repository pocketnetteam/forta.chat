import type { ChatDatabase, LocalRoom, LocalMessageStatus } from "./schema";
import type { MessageType } from "@/entities/chat/model/types";

/** Delta change reported by observeRoomChanges */
export type RoomChange =
  | { type: "upsert"; room: LocalRoom }
  | { type: "delete"; roomId: string };

export class RoomRepository {
  constructor(private db: ChatDatabase) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** Self-heal rooms with updatedAt=0 — use best available fallback timestamp.
   *  IMPORTANT: do NOT use syncedAt — it's Date.now() on every sync and inflates
   *  rooms without messages to the top of the sorted list. */
  private healUpdatedAt(rooms: LocalRoom[]): LocalRoom[] {
    for (const r of rooms) {
      if (!r.updatedAt) {
        r.updatedAt = r.lastMessageTimestamp || 1;
      }
    }
    return rooms;
  }

  /** Sort key: all rooms (joined + invited) sorted by effective timestamp.
   *  Falls back to updatedAt for rooms without messages (e.g. fresh invites
   *  where updatedAt = invite origin_server_ts). */
  private sortKey(r: LocalRoom): number {
    return r.lastMessageTimestamp || r.updatedAt || 0;
  }

  /** Get all joined rooms (UNSORTED), excluding tombstones.
   *  Caller (chat-store) is responsible for sorting. */
  async getJoinedRooms(): Promise<LocalRoom[]> {
    const rooms = await this.db.rooms
      .where("membership")
      .equals("join")
      .and(r => !r.isDeleted)
      .toArray();
    return this.healUpdatedAt(rooms);
  }

  /** Get invited rooms, excluding tombstones */
  async getInvitedRooms(): Promise<LocalRoom[]> {
    return this.db.rooms.where("membership").equals("invite")
      .and(r => !r.isDeleted)
      .toArray();
  }

  /** Get all active rooms (joined + invited, non-tombstoned). Returns UNSORTED.
   *  Caller (chat-store) is responsible for sorting. */
  async getAllRooms(): Promise<LocalRoom[]> {
    const rooms = await this.db.rooms
      .where("membership")
      .anyOf(["join", "invite"])
      .and(r => !r.isDeleted)
      .toArray();
    return this.healUpdatedAt(rooms);
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

  /** Bulk-sync room metadata in a SINGLE Dexie transaction.
   *  - Existing rooms: update metadata only (preserve preview/unread/watermark fields)
   *  - Tombstoned rooms: revive + update metadata
   *  - New rooms: full insert with initial state
   *  One transaction = one liveQuery notification (instead of N). */
  async bulkSyncRooms(
    roomUpdates: Array<{
      id: string;
      name?: string;
      avatar?: string;
      isGroup?: boolean;
      members?: string[];
      membership?: "join" | "invite" | "leave";
      topic?: string;
      syncedAt?: number;
      updatedAt?: number;
      lastMessageTimestamp?: number;
      // Cross-device unread reconciliation: server-reported unread count.
      // If serverUnreadCount is 0 but local Dexie has >0, another device read them.
      serverUnreadCount?: number;
      // Full insert fields (only for genuinely new rooms)
      unreadCount?: number;
      hasMoreHistory?: boolean;
      lastReadInboundTs?: number;
      lastReadOutboundTs?: number;
      lastMessagePreview?: string;
      lastMessageSenderId?: string;
      lastMessageType?: MessageType;
      lastMessageEventId?: string;
      lastMessageLocalStatus?: LocalMessageStatus;
      lastMessageReaction?: LocalRoom["lastMessageReaction"];
      isDeleted?: boolean;
      deletedAt?: number | null;
      deleteReason?: "left" | "kicked" | "banned" | "removed" | null;
      historyVisibility?: string | null;
    }>,
  ): Promise<void> {
    if (roomUpdates.length === 0) return;

    await this.db.transaction("rw", this.db.rooms, async () => {
      const ids = roomUpdates.map((u) => u.id);
      const existing = await this.db.rooms.bulkGet(ids);
      const existingMap = new Map<string, LocalRoom>();
      for (const room of existing) {
        if (room) existingMap.set(room.id, room);
      }

      const toPut: LocalRoom[] = [];

      for (const update of roomUpdates) {
        const prev = existingMap.get(update.id);

        if (prev) {
          // ── Existing room: skip if nothing display-relevant changed ──
          const tsAdvanced = (update.lastMessageTimestamp ?? 0) > (prev.lastMessageTimestamp ?? 0)
            || (update.updatedAt ?? 0) > (prev.updatedAt ?? 0);
          const metaChanged = (update.name !== undefined && update.name !== prev.name)
            || (update.avatar !== undefined && update.avatar !== prev.avatar)
            || (update.membership !== undefined && update.membership !== prev.membership)
            || (update.topic !== undefined && update.topic !== prev.topic)
            || (update.historyVisibility !== undefined && update.historyVisibility !== (prev.historyVisibility ?? null));
          // Unread reconciliation: Matrix SDK is the single source of truth.
          // EventWriter does NOT touch unreadCount — so serverUnreadCount is always authoritative.
          const unreadChanged = update.serverUnreadCount !== undefined
            && (prev.unreadCount ?? 0) !== update.serverUnreadCount;
          const needsRevive = prev.isDeleted;

          if (!tsAdvanced && !metaChanged && !unreadChanged && !needsRevive) {
            continue; // Skip unchanged room — avoid unnecessary Dexie write
          }

          // ── Update metadata ──
          const patched: LocalRoom = { ...prev };

          if (update.name !== undefined) patched.name = update.name;
          if (update.avatar !== undefined) patched.avatar = update.avatar;
          if (update.isGroup !== undefined) patched.isGroup = update.isGroup;
          if (update.members !== undefined) patched.members = update.members;
          if (update.membership !== undefined) patched.membership = update.membership;
          if (update.topic !== undefined) patched.topic = update.topic;
          if (update.syncedAt !== undefined) patched.syncedAt = update.syncedAt;
          if (update.historyVisibility !== undefined) patched.historyVisibility = update.historyVisibility;

          // Monotonically advance timestamps
          if (update.updatedAt !== undefined) {
            patched.updatedAt = Math.max(prev.updatedAt ?? 0, update.updatedAt);
          }
          if (update.lastMessageTimestamp !== undefined) {
            // Clear-history guard: never restore a timestamp that predates the clear marker
            const effectiveTs = prev.clearedAtTs && update.lastMessageTimestamp <= prev.clearedAtTs
              ? prev.lastMessageTimestamp ?? 0
              : update.lastMessageTimestamp;
            patched.lastMessageTimestamp = Math.max(
              prev.lastMessageTimestamp ?? 0,
              effectiveTs,
            );
          }

          // Revive tombstoned rooms
          if (needsRevive) {
            patched.isDeleted = false;
            patched.deletedAt = null;
            patched.deleteReason = null;
          }

          // Matrix SDK is the single source of truth for unread counts.
          // Always overwrite local count with server value.
          if (unreadChanged) {
            patched.unreadCount = update.serverUnreadCount!;
            // When server says 0, advance watermark so local state stays consistent
            if (update.serverUnreadCount === 0) {
              const latestTs = prev.lastMessageTimestamp ?? prev.updatedAt ?? 0;
              if (latestTs > (prev.lastReadInboundTs ?? 0)) {
                patched.lastReadInboundTs = latestTs;
              }
            }
          }

          toPut.push(patched);
        } else {
          // ── New room: full insert with defaults ──
          const newRoom: LocalRoom = {
            id: update.id,
            name: update.name ?? "",
            avatar: update.avatar,
            isGroup: update.isGroup ?? false,
            members: update.members ?? [],
            membership: update.membership ?? "join",
            unreadCount: update.unreadCount ?? 0,
            updatedAt: update.updatedAt ?? Date.now(),
            hasMoreHistory: update.hasMoreHistory ?? true,
            lastReadInboundTs: update.lastReadInboundTs ?? 0,
            lastReadOutboundTs: update.lastReadOutboundTs ?? 0,
            topic: update.topic,
            syncedAt: update.syncedAt ?? Date.now(),
            isDeleted: update.isDeleted ?? false,
            deletedAt: update.deletedAt ?? null,
            deleteReason: update.deleteReason ?? null,
            // Preview fields — only set for new rooms
            lastMessagePreview: update.lastMessagePreview,
            lastMessageTimestamp: update.lastMessageTimestamp,
            lastMessageSenderId: update.lastMessageSenderId,
            lastMessageType: update.lastMessageType,
            lastMessageEventId: update.lastMessageEventId,
            lastMessageLocalStatus: update.lastMessageLocalStatus,
            lastMessageDecryptionStatus: undefined,
            lastMessageReaction: update.lastMessageReaction ?? null,
            historyVisibility: update.historyVisibility ?? null,
          };
          toPut.push(newRoom);
        }
      }

      await this.db.rooms.bulkPut(toPut);
    });
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
    callInfo?: { callType: "voice" | "video"; missed: boolean; duration?: number },
    systemMeta?: { template: string; senderAddr: string; targetAddr?: string; extra?: Record<string, string> },
  ): Promise<void> {
    // Monotonic guard — never roll back to an older preview
    const existing = await this.db.rooms.get(roomId);
    if (existing?.lastMessageTimestamp && timestamp < existing.lastMessageTimestamp) {
      return;
    }
    // Clear-history guard — never show preview for messages before the clear marker
    if (existing?.clearedAtTs && timestamp <= existing.clearedAtTs) {
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
      lastMessageDecryptionStatus: undefined,
      lastMessageCallInfo: callInfo ?? undefined,
      lastMessageSystemMeta: systemMeta ?? undefined,
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

  /** Recalculate unreadCount from watermarks + actual messages in Dexie.
   *  Self-healing: fixes drift caused by races, stale reconciliation, etc.
   *  Only corrects if the computed count differs from the stored count.
   *
   *  WARNING: Not safe to call during active message ingestion — the read+count+write
   *  sequence is not atomic. Call only at quiescent points (app resume, after init).
   *  @param countFn — matches MessageRepository.countInboundAfter signature */
  async recalculateUnreadCount(
    roomId: string,
    myAddress: string,
    countFn: (roomId: string, afterTs: number, excludeSenderId: string, clearedAtTs?: number) => Promise<number>,
  ): Promise<void> {
    const room = await this.getRoom(roomId);
    if (!room) return;

    const watermark = room.lastReadInboundTs ?? 0;
    const computed = await countFn(roomId, watermark, myAddress, room.clearedAtTs);

    if (computed !== room.unreadCount) {
      await this.db.rooms.update(roomId, { unreadCount: computed });
    }
  }

  /** Recalculate unreadCount for all joined rooms. */
  async recalculateAllUnreadCounts(
    myAddress: string,
    countFn: (roomId: string, afterTs: number, excludeSenderId: string, clearedAtTs?: number) => Promise<number>,
  ): Promise<number> {
    const rooms = await this.getAllRooms();
    let corrected = 0;
    for (const room of rooms) {
      const watermark = room.lastReadInboundTs ?? 0;
      const computed = await countFn(room.id, watermark, myAddress, room.clearedAtTs);

      if (computed !== room.unreadCount) {
        await this.db.rooms.update(room.id, { unreadCount: computed });
        corrected++;
      }
    }
    return corrected;
  }

  /** Update outbound read watermark (other party read our messages up to this timestamp) */
  async updateOutboundWatermark(roomId: string, timestamp: number): Promise<void> {
    const room = await this.getRoom(roomId);
    if (!room) return;
    // Watermark only moves forward (monotonic)
    if (timestamp <= (room.lastReadOutboundTs ?? 0)) return;
    await this.db.rooms.update(roomId, { lastReadOutboundTs: timestamp });
  }

  /** Update inbound read watermark + clear unread (we read messages up to this timestamp).
   *  Uses atomic modify() to prevent race with concurrent writeMessage() unread increment. */
  async markAsRead(roomId: string, timestamp: number): Promise<void> {
    await this.db.rooms.where("id").equals(roomId)
      .modify((room: LocalRoom) => {
        if (timestamp <= (room.lastReadInboundTs ?? 0)) return; // watermark only moves forward
        room.lastReadInboundTs = timestamp;
        room.unreadCount = 0;
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

  /** Bulk-remove rooms and their messages in a single transaction */
  async bulkRemoveRooms(roomIds: string[]): Promise<void> {
    if (roomIds.length === 0) return;
    await this.db.transaction("rw", [this.db.rooms, this.db.messages], async () => {
      for (const id of roomIds) {
        await this.db.messages.where("[roomId+timestamp]")
          .between([id, -Infinity], [id, Infinity])
          .delete();
      }
      await this.db.rooms.bulkDelete(roomIds);
    });
  }

  // ---------------------------------------------------------------------------
  // Optimistic update from push notification
  // ---------------------------------------------------------------------------

  /**
   * Instantly update a room's preview and unread count from a push notification
   * payload. Called BEFORE Matrix /sync completes, so the user sees fresh data
   * in the room list immediately after tapping a push.
   *
   * SAFETY GUARANTEES:
   * - Monotonic: skips if room already has a newer lastMessageTimestamp.
   *   This means when EventWriter processes the real /sync response later,
   *   it will call updateLastMessage() which has its own monotonic guard —
   *   if the push timestamp equals the real event's timestamp, the sync
   *   write is a no-op (same data). If the real event has a newer timestamp,
   *   it overwrites our optimistic preview (correct behavior).
   * - No transaction conflicts: this is a simple Dexie.update() — it writes
   *   directly to IndexedDB without touching messages table.
   * - Soft fields only: only updates preview/unread/timestamp, never touches
   *   structural fields (membership, members, pagination).
   * - No-op for unknown rooms: if the room doesn't exist in Dexie yet
   *   (first message from a new contact), we skip — EventWriter.ensureRoomExists()
   *   will create it when /sync arrives.
   */
  async optimisticUpdateFromPush(
    roomId: string,
    previewText: string,
    timestamp: number,
    senderId?: string,
    messageType?: MessageType,
  ): Promise<boolean> {
    const existing = await this.db.rooms.get(roomId);
    if (!existing) return false; // room not in Dexie yet — let /sync handle it
    if (existing.isDeleted) return false; // tombstoned — don't revive from push

    // Monotonic guard — never roll back to an older preview
    if (existing.lastMessageTimestamp && timestamp <= existing.lastMessageTimestamp) {
      // Timestamp not newer — but still bump unread if it looks like a new message
      // (push can arrive for a message with same-second timestamp as the last one)
      if (timestamp === existing.lastMessageTimestamp) return false;
      return false;
    }

    // Clear-history guard — don't show preview for messages before clear marker
    if (existing.clearedAtTs && timestamp <= existing.clearedAtTs) return false;

    const changes: Partial<LocalRoom> = {
      lastMessagePreview: previewText.slice(0, 200),
      lastMessageTimestamp: timestamp,
      updatedAt: Math.max(timestamp, existing.updatedAt ?? 0),
      // Increment unread — atomic update prevents races with concurrent writes.
      // When EventWriter processes the same message later, it checks "inserted"
      // vs "duplicate" — if the message was already written by /sync before
      // this push handler ran, this code won't execute (monotonic guard above).
      unreadCount: (existing.unreadCount ?? 0) + 1,
    };

    if (senderId) changes.lastMessageSenderId = senderId;
    if (messageType) changes.lastMessageType = messageType;

    await this.db.rooms.update(roomId, changes);
    return true;
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

  /** Clear chat history: set clearedAtTs marker and reset preview/pagination.
   *  Uses null (not undefined) because Dexie.update() silently ignores undefined values. */
  async clearHistory(roomId: string, clearedAtTs: number): Promise<void> {
    await this.db.rooms.update(roomId, {
      clearedAtTs,
      lastMessagePreview: null as unknown as undefined,
      lastMessageTimestamp: null as unknown as undefined,
      lastMessageSenderId: null as unknown as undefined,
      lastMessageType: null as unknown as undefined,
      lastMessageEventId: null as unknown as undefined,
      lastMessageReaction: null,
      lastMessageLocalStatus: null as unknown as undefined,
      lastMessageDecryptionStatus: null as unknown as undefined,
      lastMessageCallInfo: null as unknown as undefined,
      lastMessageSystemMeta: null as unknown as undefined,
      unreadCount: 0,
      paginationToken: null as unknown as undefined,
      hasMoreHistory: false,
    });
  }

  /** Get clearedAtTs for a room */
  async getClearedAtTs(roomId: string): Promise<number | undefined> {
    const room = await this.db.rooms.get(roomId);
    return room?.clearedAtTs;
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

  // ---------------------------------------------------------------------------
  // Reactive observation (delta-based)
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to room table changes via Dexie hooks.
   * Changes are micro-batched: multiple writes in the same tick are delivered
   * as a single callback invocation.
   * Returns an unsubscribe function.
   */
  observeRoomChanges(callback: (changes: RoomChange[]) => void): () => void {
    let buffer: RoomChange[] = [];
    let flushScheduled = false;

    const scheduleFlush = () => {
      if (flushScheduled) return;
      flushScheduled = true;
      queueMicrotask(() => {
        flushScheduled = false;
        if (buffer.length === 0) return;
        const batch = buffer;
        buffer = [];
        callback(batch);
      });
    };

    const onCreating = function (this: any, primKey: string, obj: LocalRoom) {
      buffer.push({ type: "upsert", room: { ...obj } });
      scheduleFlush();
    };

    const onUpdating = function (this: any, mods: object, primKey: string, obj: LocalRoom) {
      const updated = { ...obj, ...mods } as LocalRoom;
      buffer.push({ type: "upsert", room: updated });
      scheduleFlush();
    };

    const onDeleting = function (this: any, primKey: string, obj: LocalRoom) {
      buffer.push({ type: "delete", roomId: primKey });
      scheduleFlush();
    };

    this.db.rooms.hook("creating", onCreating);
    this.db.rooms.hook("updating", onUpdating);
    this.db.rooms.hook("deleting", onDeleting);

    return () => {
      this.db.rooms.hook("creating").unsubscribe(onCreating);
      this.db.rooms.hook("updating").unsubscribe(onUpdating);
      this.db.rooms.hook("deleting").unsubscribe(onDeleting);
      buffer = [];
    };
  }
}
