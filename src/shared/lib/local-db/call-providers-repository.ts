import type { ChatDatabase, CallProvider } from "./schema";

/**
 * Repository for user-configured external call providers (WEE-57).
 *
 * PRIVACY CONTRACT: this repository touches ONLY the local IndexedDB table.
 * It never imports or calls the Matrix client, never writes to account_data,
 * and never reaches the Pocketnet backend. Personal meeting-room URLs (Zoom
 * personal links, Google Meet invites, …) must stay on this device. Any
 * change that introduces a server write here is a privacy regression — see
 * the regression test in `__tests__/call-providers-repository.test.ts`.
 */
export class CallProvidersRepository {
  constructor(private db: ChatDatabase) {}

  /** All providers, insertion order (PK ascending). */
  async toArray(): Promise<CallProvider[]> {
    return this.db.callProviders.toArray();
  }

  /**
   * Add a provider. When `isDefault` is true, demotes every other provider
   * first so at most one default exists.
   */
  async add(provider: Omit<CallProvider, "id">): Promise<number> {
    return this.db.transaction("rw", this.db.callProviders, async () => {
      if (provider.isDefault) {
        await this.db.callProviders.toCollection().modify({ isDefault: false });
      }
      return this.db.callProviders.add(provider as CallProvider) as Promise<number>;
    });
  }

  /**
   * Patch an existing provider. Promoting one to default demotes the rest.
   */
  async update(id: number, patch: Partial<Omit<CallProvider, "id">>): Promise<void> {
    await this.db.transaction("rw", this.db.callProviders, async () => {
      if (patch.isDefault) {
        await this.db.callProviders.toCollection().modify({ isDefault: false });
      }
      await this.db.callProviders.update(id, patch);
    });
  }

  /** Remove a provider. */
  async delete(id: number): Promise<void> {
    await this.db.callProviders.delete(id);
  }

  /** Mark exactly one provider as the quick-tap default (demotes others). */
  async setDefault(id: number): Promise<void> {
    await this.db.transaction("rw", this.db.callProviders, async () => {
      await this.db.callProviders.toCollection().modify({ isDefault: false });
      await this.db.callProviders.update(id, { isDefault: true });
    });
  }

  /** The default provider, or undefined when none is marked. */
  async getDefault(): Promise<CallProvider | undefined> {
    const all = await this.db.callProviders.toArray();
    return all.find((p) => p.isDefault);
  }

  /** Wipe all providers (used by tests and "clear data"). */
  async clear(): Promise<void> {
    await this.db.callProviders.clear();
  }
}
