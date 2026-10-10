// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import {
  MATRIX_BOOT_CACHE_TTL_MS,
  clearCachedMatrixSession,
  readCachedMatrixHost,
  readCachedMatrixSession,
  readCachedSyncFilterId,
  writeCachedMatrixHost,
  writeCachedMatrixSession,
  writeCachedSyncFilterId,
} from "../matrix-session-cache";

const SESSION = { userId: "@u:server", accessToken: "tok", deviceId: "DEV" };
const T0 = 1_700_000_000_000;

describe("matrix-session-cache", () => {
  beforeEach(() => localStorage.clear());

  describe("session", () => {
    it("returns a session within 3 days of the login", () => {
      writeCachedMatrixSession("addr", SESSION, T0);
      expect(readCachedMatrixSession("addr", T0 + MATRIX_BOOT_CACHE_TTL_MS - 1)).toEqual({ ...SESSION, obtainedAt: T0 });
    });

    it("expires after 3 days", () => {
      writeCachedMatrixSession("addr", SESSION, T0);
      expect(readCachedMatrixSession("addr", T0 + MATRIX_BOOT_CACHE_TTL_MS)).toBeNull();
    });

    it("rejects a timestamp from the future (clock moved back)", () => {
      writeCachedMatrixSession("addr", SESSION, T0);
      expect(readCachedMatrixSession("addr", T0 - 1000)).toBeNull();
    });

    it("is per account and cleared on demand", () => {
      writeCachedMatrixSession("addr", SESSION, T0);
      expect(readCachedMatrixSession("other", T0)).toBeNull();
      clearCachedMatrixSession("addr");
      expect(readCachedMatrixSession("addr", T0)).toBeNull();
    });

    it("ignores incomplete or corrupt entries", () => {
      writeCachedMatrixSession("addr", { ...SESSION, accessToken: "" }, T0);
      expect(readCachedMatrixSession("addr", T0)).toBeNull();
      localStorage.setItem("matrix_session:addr", "{not json");
      expect(readCachedMatrixSession("addr", T0)).toBeNull();
    });
  });

  describe("host", () => {
    const HOSTS = ["a.example", "b.example"];

    it("returns a host probed within 3 days", () => {
      writeCachedMatrixHost("b.example", T0);
      expect(readCachedMatrixHost(HOSTS, T0 + 1000)).toBe("b.example");
      expect(readCachedMatrixHost(HOSTS, T0 + MATRIX_BOOT_CACHE_TTL_MS)).toBeNull();
    });

    it("ignores a host no longer in the configured list", () => {
      writeCachedMatrixHost("gone.example", T0);
      expect(readCachedMatrixHost(HOSTS, T0)).toBeNull();
    });
  });

  describe("sync filter id", () => {
    const DEF = { room: { timeline: { limit: 4 } } };

    it("returns the id only for the same definition", () => {
      writeCachedSyncFilterId("addr", DEF, "42");
      expect(readCachedSyncFilterId("addr", { room: { timeline: { limit: 4 } } })).toBe("42");
      expect(readCachedSyncFilterId("addr", { room: { timeline: { limit: 20 } } })).toBeNull();
      expect(readCachedSyncFilterId("other", DEF)).toBeNull();
    });
  });
});
