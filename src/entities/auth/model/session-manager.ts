export interface StoredSession {
  address: string;
  privateKey: string;
  addedAt: number;
  accessToken?: string;
  homeserverUrl?: string;
  syncToken?: string;
}

const SESSIONS_KEY = "forta-chat:sessions";
const ACTIVE_KEY = "forta-chat:activeAccount";
const OLD_AUTH_KEY = "forta-chat:auth";
const MAX_ACCOUNTS = 5;

export class SessionManager {
  /**
   * Migrates singleton `forta-chat:auth` to multi-account format.
   * Idempotent: skips if sessions already exist, or if old auth is missing/has null address.
   */
  migrate(): void {
    // Skip if already migrated
    const existingSessions = localStorage.getItem(SESSIONS_KEY);
    if (existingSessions) return;

    const raw = localStorage.getItem(OLD_AUTH_KEY);
    if (!raw) return;

    let oldAuth: { address: string | null; privateKey: string };
    try {
      oldAuth = JSON.parse(raw);
    } catch {
      return;
    }

    if (!oldAuth.address) return;

    const session: StoredSession = {
      address: oldAuth.address,
      privateKey: oldAuth.privateKey,
      addedAt: Date.now(),
    };

    localStorage.setItem(SESSIONS_KEY, JSON.stringify([session]));
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(oldAuth.address));
    localStorage.removeItem(OLD_AUTH_KEY);
  }

  getSessions(): StoredSession[] {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (!raw) return [];
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  getActiveAddress(): string | null {
    const raw = localStorage.getItem(ACTIVE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  getSession(address: string): StoredSession | null {
    const sessions = this.getSessions();
    return sessions.find((s) => s.address === address) ?? null;
  }

  /**
   * Appends a session to the list. Does not change the active account — callers
   * must call `setActive` when the new session should become current (e.g. login
   * via `setAuthData`), or leave active unchanged so `switchAccount` can run a
   * full Matrix/Dexie teardown (add-account flow).
   */
  addSession(address: string, privateKey: string): void {
    const sessions = this.getSessions();

    // Skip duplicates
    if (sessions.some((s) => s.address === address)) return;

    if (sessions.length >= MAX_ACCOUNTS) {
      throw new Error(
        `Maximum of ${MAX_ACCOUNTS} accounts reached`,
      );
    }

    const session: StoredSession = {
      address,
      privateKey,
      addedAt: Date.now(),
    };

    sessions.push(session);
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  }

  removeSession(address: string): void {
    let sessions = this.getSessions();
    sessions = sessions.filter((s) => s.address !== address);
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));

    const active = this.getActiveAddress();
    if (active === address) {
      if (sessions.length > 0) {
        this.setActive(sessions[0].address);
      } else {
        localStorage.removeItem(ACTIVE_KEY);
      }
    }
  }

  setActive(address: string): void {
    const sessions = this.getSessions();
    if (!sessions.some((s) => s.address === address)) {
      throw new Error(`Unknown session address: ${address}`);
    }
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(address));
  }

  updateSyncToken(address: string, token: string): void {
    const sessions = this.getSessions();
    const session = sessions.find((s) => s.address === address);
    if (!session) return;
    session.syncToken = token;
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  }

  updateConnectionInfo(
    address: string,
    accessToken: string,
    homeserverUrl: string,
  ): void {
    const sessions = this.getSessions();
    const session = sessions.find((s) => s.address === address);
    if (!session) return;
    session.accessToken = accessToken;
    session.homeserverUrl = homeserverUrl;
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  }
}
