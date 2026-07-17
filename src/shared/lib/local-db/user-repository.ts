import type { ChatDatabase, LocalUser } from "./schema";

export class UserRepository {
  constructor(private db: ChatDatabase) {}

  /** Get a user by address */
  async getUser(address: string): Promise<LocalUser | undefined> {
    return this.db.users.get(address);
  }

  /** Get multiple users by addresses */
  async getUsers(addresses: string[]): Promise<LocalUser[]> {
    return this.db.users.where("address").anyOf(addresses).toArray();
  }

  /** Upsert a user (insert or update) */
  async upsertUser(user: LocalUser): Promise<void> {
    await this.db.users.put(user);
  }

  /** Bulk upsert users */
  async bulkUpsertUsers(users: LocalUser[]): Promise<void> {
    await this.db.users.bulkPut(users);
  }

  /** Get a display name, returning address as fallback */
  async getDisplayName(address: string): Promise<string> {
    const user = await this.getUser(address);
    return user?.name || address.slice(0, 8) + "...";
  }

  /** Find users whose data is stale (syncedAt older than given threshold) */
  async getStaleUsers(olderThanMs: number): Promise<LocalUser[]> {
    const threshold = Date.now() - olderThanMs;
    return this.db.users
      .where("updatedAt")
      .below(threshold)
      .toArray();
  }

  /** Delete a user from cache */
  async deleteUser(address: string): Promise<void> {
    await this.db.users.delete(address);
  }

  // ------------------------------------------------------------------
  // Local alias (Session 51) — Telegram-style contact rename.
  //
  // Alias state lives in the existing `users` row to avoid a new table.
  // Unknown users (no profile yet) get a skeleton row so the alias survives
  // until the real profile arrives via /sync.
  // ------------------------------------------------------------------

  /** Set or clear a user's local alias.
   *  Passing `alias = null` clears the alias but keeps the timestamp bump,
   *  enabling LWW-based cross-device sync to propagate the tombstone. */
  async setAlias(address: string, alias: string | null, updatedAt: number = Date.now()): Promise<void> {
    const existing = await this.db.users.get(address);
    const next: LocalUser = {
      address,
      name: existing?.name ?? "",
      about: existing?.about,
      image: existing?.image,
      updatedAt: existing?.updatedAt ?? 0,
      syncedAt: existing?.syncedAt ?? 0,
      localAlias: alias ?? undefined,
      aliasUpdatedAt: updatedAt,
    };
    await this.db.users.put(next);
  }

  /** Get the local alias (or null if none set). */
  async getAlias(address: string): Promise<string | null> {
    const u = await this.db.users.get(address);
    return u?.localAlias ?? null;
  }

  /** Get the timestamp of the last alias change (0 if never set). */
  async getAliasUpdatedAt(address: string): Promise<number> {
    const u = await this.db.users.get(address);
    return u?.aliasUpdatedAt ?? 0;
  }

  /** Return all users that currently have a non-empty alias.
   *  Used to hydrate chat-store.localAliases on login. */
  async getAllAliases(): Promise<Record<string, { alias: string; updatedAt: number }>> {
    const users = await this.db.users.filter(u => !!u.localAlias).toArray();
    const out: Record<string, { alias: string; updatedAt: number }> = {};
    for (const u of users) {
      if (u.localAlias) {
        out[u.address] = { alias: u.localAlias, updatedAt: u.aliasUpdatedAt ?? 0 };
      }
    }
    return out;
  }
}
