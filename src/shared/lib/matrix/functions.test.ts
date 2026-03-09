/**
 * Tests for the core hex encoding/decoding and Matrix ID functions.
 *
 * These are the MOST critical functions in the app — a bug here breaks:
 * - User identity (who sent a message)
 * - Encryption key lookup (decryptKey uses hex-encoded sender)
 * - Avatar resolution (Pocketnet API needs raw address)
 * - Typing indicators, reactions, read receipts
 */
import { describe, it, expect } from "vitest";
import { hexEncode, hexDecode, getmatrixid, getmatrixidFA, Base64, tetatetid, deep, md5, areArraysEqual } from "./functions";

// Real Bastyon addresses from production
const BASTYON_ADDRESSES = [
  "PPbNqCweFnTePQyXWR21B9jXWCiDJa2yYu",
  "PHxLqCwAG4s2G9DmNHHWxMXXm77EkzqJUf",
  "P9hB2dZ7YLfDGGBDYRwn6u38AQ6cNg12Rx",
];

describe("hexEncode", () => {
  it("encodes ASCII strings to hex", () => {
    expect(hexEncode("A")).toBe("41");
    expect(hexEncode("AB")).toBe("4142");
    expect(hexEncode("abc")).toBe("616263");
  });

  it("encodes a real Bastyon address deterministically", () => {
    const hex = hexEncode("PPbNqCweFnTePQyXWR21B9jXWCiDJa2yYu");
    // Must be lowercase hex of ASCII codes
    expect(hex).toMatch(/^[0-9a-f]+$/);
    // Each char → 2 hex digits, so length doubles
    expect(hex.length).toBe("PPbNqCweFnTePQyXWR21B9jXWCiDJa2yYu".length * 2);
  });

  it("handles empty string", () => {
    expect(hexEncode("")).toBe("");
  });
});

describe("hexDecode", () => {
  it("decodes hex back to ASCII", () => {
    expect(hexDecode("41")).toBe("A");
    expect(hexDecode("4142")).toBe("AB");
    expect(hexDecode("616263")).toBe("abc");
  });

  it("handles empty string", () => {
    expect(hexDecode("")).toBe("");
  });
});

describe("hexEncode ↔ hexDecode roundtrip", () => {
  it("roundtrips for all real Bastyon addresses", () => {
    for (const addr of BASTYON_ADDRESSES) {
      const encoded = hexEncode(addr);
      const decoded = hexDecode(encoded);
      expect(decoded).toBe(addr);
    }
  });

  it("roundtrips for alphanumeric strings", () => {
    const strings = ["hello", "Test123", "0x00FF", "ABCDEFGHIJKLMNOP"];
    for (const s of strings) {
      expect(hexDecode(hexEncode(s))).toBe(s);
    }
  });

  it("hexEncode output is always lowercase hex for ASCII input", () => {
    for (const addr of BASTYON_ADDRESSES) {
      const hex = hexEncode(addr);
      expect(hex).toMatch(/^[0-9a-f]+$/);
    }
  });
});

describe("getmatrixid", () => {
  it("strips @ prefix and :server suffix from Matrix user ID", () => {
    expect(getmatrixid("@username:matrix.server.com")).toBe("username");
  });

  it("handles bare hex-encoded address (no @ or :)", () => {
    const hex = hexEncode("PPbNqCweFnTePQyXWR21B9jXWCiDJa2yYu");
    expect(getmatrixid(hex)).toBe(hex);
  });

  it("handles full Matrix ID with hex-encoded address", () => {
    const hex = hexEncode("PPbNqCweFnTePQyXWR21B9jXWCiDJa2yYu");
    const matrixId = `@${hex}:matrix.pocketnet.app`;
    expect(getmatrixid(matrixId)).toBe(hex);
  });

  it("returns empty string for null/undefined", () => {
    expect(getmatrixid(null)).toBe("");
    expect(getmatrixid(undefined)).toBe("");
    expect(getmatrixid("")).toBe("");
  });
});

describe("getmatrixidFA", () => {
  it("preserves @ prefix", () => {
    expect(getmatrixidFA("@username:server")).toBe("@username");
  });

  it("returns empty for null", () => {
    expect(getmatrixidFA(null)).toBe("");
  });
});

describe("Base64", () => {
  it("encodes and decodes ASCII text", () => {
    const text = "Hello, World!";
    expect(Base64.decode(Base64.encode(text))).toBe(text);
  });

  it("encodes and decodes JSON payloads (like encryption secrets)", () => {
    const json = JSON.stringify({ keys: "abc123", block: 42, v: 1 });
    expect(Base64.decode(Base64.encode(json))).toBe(json);
  });

  it("handles empty string", () => {
    expect(Base64.decode(Base64.encode(""))).toBe("");
  });
});

// ─── tetatetid ──────────────────────────────────────────────────

describe("tetatetid", () => {
  const hexA = hexEncode("PPbNqCweFnTePQyXWR21B9jXWCiDJa2yYu");
  const hexB = hexEncode("PHxLqCwAG4s2G9DmNHHWxMXXm77EkzqJUf");

  it("returns a SHA-224 hex hash (56 chars)", () => {
    const result = tetatetid(hexA, hexB);
    expect(result).toMatch(/^[0-9a-f]{56}$/);
  });

  it("is commutative — same result regardless of argument order", () => {
    expect(tetatetid(hexA, hexB)).toBe(tetatetid(hexB, hexA));
  });

  it("returns null when both IDs are the same", () => {
    expect(tetatetid(hexA, hexA)).toBeNull();
  });

  it("returns different hashes for different pairs", () => {
    const hexC = hexEncode("P9hB2dZ7YLfDGGBDYRwn6u38AQ6cNg12Rx");
    expect(tetatetid(hexA, hexB)).not.toBe(tetatetid(hexA, hexC));
  });

  it("versioned alias differs from base alias", () => {
    const base = tetatetid(hexA, hexB);
    const v2 = tetatetid(hexA, hexB, 2);
    expect(v2).not.toBe(base);
    expect(v2).toMatch(/^[0-9a-f]{56}$/);
  });

  it("is deterministic — same inputs always produce same output", () => {
    const r1 = tetatetid(hexA, hexB);
    const r2 = tetatetid(hexA, hexB);
    expect(r1).toBe(r2);
  });
});

// ─── deep ───────────────────────────────────────────────────────

describe("deep", () => {
  it("accesses nested property by dot-separated string", () => {
    const obj = { a: { b: { c: 42 } } };
    expect(deep(obj, "a.b.c")).toBe(42);
  });

  it("accesses nested property by array of keys", () => {
    const obj = { x: { y: "hello" } };
    expect(deep(obj, ["x", "y"])).toBe("hello");
  });

  it("returns undefined for missing paths", () => {
    const obj = { a: { b: 1 } };
    expect(deep(obj, "a.c.d")).toBeUndefined();
  });

  it("returns undefined for null root", () => {
    expect(deep(null, "a.b")).toBeUndefined();
  });

  it("returns undefined for undefined root", () => {
    expect(deep(undefined, "a")).toBeUndefined();
  });

  it("accesses top-level property", () => {
    expect(deep({ foo: "bar" }, "foo")).toBe("bar");
  });

  it("returns the object itself for empty key array", () => {
    const obj = { a: 1 };
    expect(deep(obj, [])).toBe(obj);
  });
});

// ─── md5 ────────────────────────────────────────────────────────

describe("md5", () => {
  it("matches known MD5 vector for empty string", () => {
    expect(md5("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
  });

  it("matches known MD5 vector for 'hello'", () => {
    expect(md5("hello")).toBe("5d41402abc4b2a76b9719d911017c592");
  });

  it("matches known MD5 vector for 'abc'", () => {
    expect(md5("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
  });

  it("is deterministic", () => {
    expect(md5("test")).toBe(md5("test"));
  });

  it("produces different hashes for different inputs", () => {
    expect(md5("foo")).not.toBe(md5("bar"));
  });
});

// ─── areArraysEqual ─────────────────────────────────────────────

describe("areArraysEqual", () => {
  it("returns true for identical arrays", () => {
    expect(areArraysEqual([1, 2, 3], [1, 2, 3])).toBe(true);
  });

  it("returns true for empty arrays", () => {
    expect(areArraysEqual([], [])).toBe(true);
  });

  it("returns false for different lengths", () => {
    expect(areArraysEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  it("returns false for same length but different elements", () => {
    expect(areArraysEqual([1, 2, 3], [1, 2, 4])).toBe(false);
  });

  it("works with string arrays", () => {
    expect(areArraysEqual(["a", "b"], ["a", "b"])).toBe(true);
    expect(areArraysEqual(["a", "b"], ["a", "c"])).toBe(false);
  });
});
