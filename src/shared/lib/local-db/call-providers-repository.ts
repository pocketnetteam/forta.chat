import type { ChatDatabase, CallProvider } from "./schema";

/**
 * Repository for user-configured external call providers (WEE-57).
 *
 * PRIVACY CONTRACT: this repository touches ONLY the local IndexedDB table.
 * It never imports or calls the Matrix client, never writes to account data,
 * and never reaches the Pocketnet backend. Personal meeting-room URLs (Zoom
 * personal links, Google Meet invites, …) must stay on this device. Any
 * change that introduces a server write here is a privacy regression — see
 * the regression test in `__tests__/call-providers-repository.test.ts`.
 *
 * A provider is just a labelled URL — provider-agnostic on purpose.
 */
export class CallProvidersRepository {
  constructor(private db: ChatDatabase) {}

  /** All providers, insertion order (PK ascending). */
  async toArray(): Promise<CallProvider[]> {
    return this.db.callProviders.toArray();
  }

  /** Add a provider. Returns its new id. */
  async add(provider: Omit<CallProvider, "id">): Promise<number> {
    return this.db.callProviders.add(provider as CallProvider) as Promise<number>;
  }

  /** Patch an existing provider. */
  async update(id: number, patch: Partial<Omit<CallProvider, "id">>): Promise<void> {
    await this.db.callProviders.update(id, patch);
  }

  /** Remove a provider. */
  async delete(id: number): Promise<void> {
    await this.db.callProviders.delete(id);
  }

  /** Wipe all providers (used by tests and "clear data"). */
  async clear(): Promise<void> {
    await this.db.callProviders.clear();
  }
}
