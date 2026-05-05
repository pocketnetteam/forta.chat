import { describe, it, expect } from "vitest";
import {
  MediaUnavailableError,
  NetworkBlockedError,
  CryptoNotReadyError,
  isNetworkBlocked,
} from "../typed-network-errors";

describe("typed-network-errors", () => {
  describe("MediaUnavailableError", () => {
    it("preserves the mxc URL and a stable name", () => {
      const err = new MediaUnavailableError("mxc://server/abc");
      expect(err.mxcUrl).toBe("mxc://server/abc");
      expect(err.name).toBe("MediaUnavailableError");
      expect(err.message).toContain("mxc://server/abc");
    });

    it("captures the underlying cause", () => {
      const root = new TypeError("Failed to fetch");
      const err = new MediaUnavailableError("mxc://server/abc", root);
      expect(err.cause).toBe(root);
    });

    it("is a subclass of Error so instanceof works", () => {
      const err = new MediaUnavailableError("mxc://server/abc");
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(MediaUnavailableError);
    });
  });

  describe("NetworkBlockedError", () => {
    it("has a stable name and message", () => {
      const err = new NetworkBlockedError();
      expect(err.name).toBe("NetworkBlockedError");
      expect(err.message).toMatch(/blocked/i);
    });

    it("preserves the underlying cause", () => {
      const root = new TypeError("Failed to fetch");
      const err = new NetworkBlockedError(root);
      expect(err.cause).toBe(root);
    });

    it("is a subclass of Error so instanceof works", () => {
      const err = new NetworkBlockedError();
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(NetworkBlockedError);
    });
  });

  describe("CryptoNotReadyError", () => {
    it("preserves the roomId and a stable name", () => {
      const err = new CryptoNotReadyError("!room:server");
      expect(err.roomId).toBe("!room:server");
      expect(err.name).toBe("CryptoNotReadyError");
      expect(err.message).toContain("!room:server");
    });

    it("is a subclass of Error so instanceof works", () => {
      const err = new CryptoNotReadyError("!room:server");
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(CryptoNotReadyError);
    });
  });

  describe("isNetworkBlocked", () => {
    it("detects Chrome's TypeError 'Failed to fetch'", () => {
      expect(isNetworkBlocked(new TypeError("Failed to fetch"))).toBe(true);
    });

    it("detects Firefox's 'NetworkError when attempting to fetch resource'", () => {
      expect(
        isNetworkBlocked(new TypeError("NetworkError when attempting to fetch resource.")),
      ).toBe(true);
    });

    it("detects 'Network request failed'", () => {
      expect(isNetworkBlocked(new Error("Network request failed"))).toBe(true);
    });

    it("detects Safari's 'Load failed' (same connectivity-block class as Failed to fetch)", () => {
      expect(isNetworkBlocked(new TypeError("Load failed"))).toBe(true);
    });

    it("detects ERR_INTERNET_DISCONNECTED in error message", () => {
      expect(
        isNetworkBlocked(new Error("net::ERR_INTERNET_DISCONNECTED")),
      ).toBe(true);
    });

    it("matches regardless of message casing", () => {
      expect(isNetworkBlocked(new TypeError("FAILED TO FETCH"))).toBe(true);
    });

    it("does not classify HTTP 5xx server errors as blocked", () => {
      expect(isNetworkBlocked(new Error("Download failed: 503"))).toBe(false);
    });

    it("does not classify generic errors as blocked", () => {
      expect(isNetworkBlocked(new Error("Unexpected token in JSON"))).toBe(false);
    });

    it("returns false for non-Error values", () => {
      expect(isNetworkBlocked(null)).toBe(false);
      expect(isNetworkBlocked(undefined)).toBe(false);
      expect(isNetworkBlocked("Failed to fetch")).toBe(false);
      expect(isNetworkBlocked(42)).toBe(false);
    });

    it("recognises a NetworkBlockedError directly", () => {
      const err = new NetworkBlockedError(new TypeError("Failed to fetch"));
      expect(isNetworkBlocked(err)).toBe(true);
    });
  });
});
