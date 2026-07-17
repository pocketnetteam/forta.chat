import type { ChatDatabase, LocalChannel } from "./schema";

/**
 * Persistence layer for Bastyon channel subscriptions. Owned by the
 * `channel-store` so its sidebar renders from Dexie immediately on
 * cold-start, before the Pocketnet RPC `getsubscribeschannels` response
 * arrives (slow under Tor / cold cache). See WEE-24.
 */
export class ChannelRepository {
  constructor(private db: ChatDatabase) {}

  /** Returns all persisted channels in their original RPC order. */
  async getAll(): Promise<LocalChannel[]> {
    return this.db.channels.orderBy("syncOrder").toArray();
  }

  /** Replace the persisted channel set with `channels`. Used after a `reset=true`
   *  RPC fetch so unsubscribed channels are removed locally too. Atomic. */
  async replaceAll(channels: LocalChannel[]): Promise<void> {
    await this.db.transaction("rw", this.db.channels, async () => {
      await this.db.channels.clear();
      if (channels.length > 0) {
        await this.db.channels.bulkPut(channels);
      }
    });
  }

  /** Append a page of freshly fetched channels. Dedupes by primary key. */
  async bulkUpsert(channels: LocalChannel[]): Promise<void> {
    if (channels.length === 0) return;
    await this.db.channels.bulkPut(channels);
  }

  /** Remove all persisted channels — invoked on logout via the chat-db lifecycle. */
  async clear(): Promise<void> {
    await this.db.channels.clear();
  }
}
