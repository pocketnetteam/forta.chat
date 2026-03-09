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
}
