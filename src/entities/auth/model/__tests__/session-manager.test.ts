import { describe, it, expect, beforeEach } from "vitest";
import { SessionManager } from "../session-manager";
import type { StoredSession } from "../session-manager";

const SESSIONS_KEY = "forta-chat:sessions";
const ACTIVE_KEY = "forta-chat:activeAccount";
const OLD_AUTH_KEY = "forta-chat:auth";

describe("SessionManager", () => {
  let sm: SessionManager;

  beforeEach(() => {
    localStorage.clear();
    sm = new SessionManager();
  });

  // --- migrate ---

  describe("migrate()", () => {
    it("migrates singleton auth to multi-account format", () => {
      localStorage.setItem(
        OLD_AUTH_KEY,
        JSON.stringify({ address: "addr1", privateKey: "pk1" }),
      );

      sm.migrate();

      const sessions: StoredSession[] = JSON.parse(
        localStorage.getItem(SESSIONS_KEY)!,
      );
      expect(sessions).toHaveLength(1);
      expect(sessions[0].address).toBe("addr1");
      expect(sessions[0].privateKey).toBe("pk1");
      expect(sessions[0].addedAt).toBeTypeOf("number");

      expect(localStorage.getItem(ACTIVE_KEY)).toBe(JSON.stringify("addr1"));
      expect(localStorage.getItem(OLD_AUTH_KEY)).toBeNull();
    });

    it("skips migration when sessions already exist", () => {
      const existing: StoredSession[] = [
        { address: "existing", privateKey: "pk", addedAt: 100 },
      ];
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(existing));
      localStorage.setItem(
        OLD_AUTH_KEY,
        JSON.stringify({ address: "old", privateKey: "oldpk" }),
      );

      sm.migrate();

      const sessions: StoredSession[] = JSON.parse(
        localStorage.getItem(SESSIONS_KEY)!,
      );
      expect(sessions).toHaveLength(1);
      expect(sessions[0].address).toBe("existing");
      // Old key should not be removed since migration was skipped
      expect(localStorage.getItem(OLD_AUTH_KEY)).not.toBeNull();
    });

    it("skips migration when no old auth data exists", () => {
      sm.migrate();

      expect(localStorage.getItem(SESSIONS_KEY)).toBeNull();
      expect(localStorage.getItem(ACTIVE_KEY)).toBeNull();
    });

    it("skips migration when old auth has null address", () => {
      localStorage.setItem(
        OLD_AUTH_KEY,
        JSON.stringify({ address: null, privateKey: "pk1" }),
      );

      sm.migrate();

      expect(localStorage.getItem(SESSIONS_KEY)).toBeNull();
      expect(localStorage.getItem(ACTIVE_KEY)).toBeNull();
      // Old key should remain since we didn't migrate
      expect(localStorage.getItem(OLD_AUTH_KEY)).not.toBeNull();
    });

    it("is idempotent — second call is a no-op", () => {
      localStorage.setItem(
        OLD_AUTH_KEY,
        JSON.stringify({ address: "addr1", privateKey: "pk1" }),
      );

      sm.migrate();
      const afterFirst = localStorage.getItem(SESSIONS_KEY);

      sm.migrate();
      const afterSecond = localStorage.getItem(SESSIONS_KEY);

      expect(afterFirst).toBe(afterSecond);
    });
  });

  // --- getSessions ---

  describe("getSessions()", () => {
    it("returns empty array when no sessions stored", () => {
      expect(sm.getSessions()).toEqual([]);
    });

    it("returns stored sessions", () => {
      const sessions: StoredSession[] = [
        { address: "a1", privateKey: "pk1", addedAt: 1 },
        { address: "a2", privateKey: "pk2", addedAt: 2 },
      ];
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));

      expect(sm.getSessions()).toEqual(sessions);
    });
  });

  // --- getActiveAddress ---

  describe("getActiveAddress()", () => {
    it("returns null when no active account", () => {
      expect(sm.getActiveAddress()).toBeNull();
    });

    it("returns active address", () => {
      localStorage.setItem(ACTIVE_KEY, JSON.stringify("addr1"));
      expect(sm.getActiveAddress()).toBe("addr1");
    });
  });

  // --- getSession ---

  describe("getSession()", () => {
    it("returns session when found", () => {
      const sessions: StoredSession[] = [
        { address: "a1", privateKey: "pk1", addedAt: 1 },
        { address: "a2", privateKey: "pk2", addedAt: 2 },
      ];
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));

      expect(sm.getSession("a2")).toEqual(sessions[1]);
    });

    it("returns null when not found", () => {
      const sessions: StoredSession[] = [
        { address: "a1", privateKey: "pk1", addedAt: 1 },
      ];
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));

      expect(sm.getSession("nonexistent")).toBeNull();
    });
  });

  // --- addSession ---

  describe("addSession()", () => {
    it("adds a new session without changing active account", () => {
      sm.addSession("addr1", "pk1");

      const sessions = sm.getSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].address).toBe("addr1");
      expect(sessions[0].privateKey).toBe("pk1");
      expect(sessions[0].addedAt).toBeTypeOf("number");
      expect(sm.getActiveAddress()).toBeNull();
    });

    it("appends to end; adding a second session does not change active (switchAccount must run teardown)", () => {
      sm.addSession("addr1", "pk1");
      sm.setActive("addr1");
      sm.addSession("addr2", "pk2");

      const sessions = sm.getSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions[0].address).toBe("addr1");
      expect(sessions[1].address).toBe("addr2");
      expect(sm.getActiveAddress()).toBe("addr1");
    });

    it("does not add duplicate addresses", () => {
      sm.addSession("addr1", "pk1");
      sm.addSession("addr1", "pk1-updated");

      const sessions = sm.getSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].privateKey).toBe("pk1");
    });

    it("throws when reaching max 5 accounts", () => {
      for (let i = 1; i <= 5; i++) {
        sm.addSession(`addr${i}`, `pk${i}`);
      }

      expect(() => sm.addSession("addr6", "pk6")).toThrow();
      expect(sm.getSessions()).toHaveLength(5);
    });
  });

  // --- removeSession ---

  describe("removeSession()", () => {
    it("removes a non-active session", () => {
      sm.addSession("addr1", "pk1");
      sm.addSession("addr2", "pk2");
      sm.setActive("addr2");

      sm.removeSession("addr1");

      expect(sm.getSessions()).toHaveLength(1);
      expect(sm.getSessions()[0].address).toBe("addr2");
      expect(sm.getActiveAddress()).toBe("addr2");
    });

    it("removes the active session and auto-switches to first remaining", () => {
      sm.addSession("addr1", "pk1");
      sm.addSession("addr2", "pk2");
      sm.addSession("addr3", "pk3");
      sm.setActive("addr3");

      sm.removeSession("addr3");

      expect(sm.getSessions()).toHaveLength(2);
      expect(sm.getActiveAddress()).toBe("addr1");
    });

    it("sets active to null when removing the last session", () => {
      sm.addSession("addr1", "pk1");

      sm.removeSession("addr1");

      expect(sm.getSessions()).toHaveLength(0);
      expect(sm.getActiveAddress()).toBeNull();
    });
  });

  // --- setActive ---

  describe("setActive()", () => {
    it("sets an existing session as active", () => {
      sm.addSession("addr1", "pk1");
      sm.addSession("addr2", "pk2");

      sm.setActive("addr1");

      expect(sm.getActiveAddress()).toBe("addr1");
    });

    it("throws for unknown address", () => {
      sm.addSession("addr1", "pk1");

      expect(() => sm.setActive("unknown")).toThrow();
    });
  });

  // --- updateSyncToken ---

  describe("updateSyncToken()", () => {
    it("updates syncToken on an existing session", () => {
      sm.addSession("addr1", "pk1");

      sm.updateSyncToken("addr1", "s_tok_123");

      const session = sm.getSession("addr1");
      expect(session?.syncToken).toBe("s_tok_123");
    });

    it("does nothing for unknown address", () => {
      sm.addSession("addr1", "pk1");

      sm.updateSyncToken("unknown", "s_tok_123");

      // No error, no change
      expect(sm.getSession("addr1")?.syncToken).toBeUndefined();
    });
  });

  // --- updateConnectionInfo ---

  describe("updateConnectionInfo()", () => {
    it("updates accessToken and homeserverUrl on an existing session", () => {
      sm.addSession("addr1", "pk1");

      sm.updateConnectionInfo("addr1", "at_123", "https://matrix.example.com");

      const session = sm.getSession("addr1");
      expect(session?.accessToken).toBe("at_123");
      expect(session?.homeserverUrl).toBe("https://matrix.example.com");
    });

    it("does nothing for unknown address", () => {
      sm.addSession("addr1", "pk1");

      sm.updateConnectionInfo("unknown", "at_123", "https://example.com");

      const session = sm.getSession("addr1");
      expect(session?.accessToken).toBeUndefined();
      expect(session?.homeserverUrl).toBeUndefined();
    });
  });
});
