/**
 * Tests for message content parsing (links, mentions).
 */
import { describe, it, expect } from "vitest";
import {
  parseMessage,
  stripMentionAddresses,
  stripBastyonLinks,
  isSafeUrl,
  truncateMessage,
  MAX_MESSAGE_LENGTH,
} from "./message-format";

describe("parseMessage", () => {
  it("returns single text segment for plain text", () => {
    const segments = parseMessage("Hello world");
    expect(segments).toEqual([{ type: "text", content: "Hello world" }]);
  });

  it("detects HTTP links", () => {
    const segments = parseMessage("Visit https://example.com today");
    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual({ type: "text", content: "Visit " });
    expect(segments[1]).toEqual({ type: "link", content: "https://example.com", href: "https://example.com" });
    expect(segments[2]).toEqual({ type: "text", content: " today" });
  });

  it("auto-prefixes www links with https", () => {
    const segments = parseMessage("Go to www.example.com");
    const link = segments.find(s => s.type === "link");
    expect(link).toBeDefined();
    expect((link as any).href).toBe("https://www.example.com");
  });

  it("handles multiple links", () => {
    const text = "Link1: https://a.com Link2: https://b.com";
    const links = parseMessage(text).filter(s => s.type === "link");
    expect(links).toHaveLength(2);
  });

  it("handles empty string", () => {
    const segments = parseMessage("");
    expect(segments).toEqual([{ type: "text", content: "" }]);
  });

  it("preserves text between and around links", () => {
    const segments = parseMessage("before https://url.com after");
    expect(segments[0]).toEqual({ type: "text", content: "before " });
    expect(segments[2]).toEqual({ type: "text", content: " after" });
  });

  // ─── Bastyon links ──────────────────────────────────────────────

  it("detects bastyon:// post link", () => {
    const txid = "a".repeat(64);
    const segments = parseMessage(`Check bastyon://post?s=${txid}`);
    const bastyonLink = segments.find(s => s.type === "bastyonLink");
    expect(bastyonLink).toBeDefined();
    expect((bastyonLink as any).txid).toBe(txid);
    expect((bastyonLink as any).isVideo).toBe(false);
  });

  it("detects bastyon:// video link (index?v=)", () => {
    const txid = "b".repeat(64);
    const segments = parseMessage(`Watch bastyon://index?v=${txid}`);
    const bastyonLink = segments.find(s => s.type === "bastyonLink");
    expect(bastyonLink).toBeDefined();
    expect((bastyonLink as any).isVideo).toBe(true);
  });

  it("detects bastyon.com post link", () => {
    const txid = "c".repeat(64);
    const segments = parseMessage(`https://bastyon.com/post?s=${txid}`);
    expect(segments).toHaveLength(1);
    expect(segments[0].type).toBe("bastyonLink");
  });

  it("detects pocketnet.app post link", () => {
    const txid = "d".repeat(64);
    const segments = parseMessage(`https://pocketnet.app/post?s=${txid}`);
    expect(segments[0].type).toBe("bastyonLink");
  });

  // ─── Mentions ───────────────────────────────────────────────────

  it("detects mention with hex address and display name", () => {
    const hexAddr = "a".repeat(68);
    const segments = parseMessage(`Hello @${hexAddr}:Alice how are you`);
    const mention = segments.find(s => s.type === "mention");
    expect(mention).toBeDefined();
    expect((mention as any).content).toBe("@Alice");
    expect((mention as any).userId).toBe(hexAddr);
  });

  it("detects mention with Cyrillic display name", () => {
    const hexAddr = "c".repeat(68);
    const segments = parseMessage(`Привет @${hexAddr}:Константин как дела`);
    const mention = segments.find(s => s.type === "mention");
    expect(mention).toBeDefined();
    expect((mention as any).content).toBe("@Константин");
    expect((mention as any).userId).toBe(hexAddr);
  });

  // ─── Mixed content ─────────────────────────────────────────────

  it("handles text + link + mention in one message", () => {
    const hexAddr = "f".repeat(68);
    const text = `Hey @${hexAddr}:Bob check https://example.com out`;
    const segments = parseMessage(text);
    const types = segments.map(s => s.type);
    expect(types).toContain("text");
    expect(types).toContain("mention");
    expect(types).toContain("link");
  });
});

// ─── stripMentionAddresses ────────────────────────────────────────

describe("stripMentionAddresses", () => {
  it("strips hex address from mentions", () => {
    const hexAddr = "a".repeat(68);
    expect(stripMentionAddresses(`@${hexAddr}:Daniel`)).toBe("@Daniel");
  });

  it("handles multiple mentions", () => {
    const hex1 = "a".repeat(68);
    const hex2 = "b".repeat(68);
    const result = stripMentionAddresses(`@${hex1}:Alice and @${hex2}:Bob`);
    expect(result).toBe("@Alice and @Bob");
  });

  it("returns empty string for empty input", () => {
    expect(stripMentionAddresses("")).toBe("");
  });

  it("returns original text if no mentions", () => {
    expect(stripMentionAddresses("Hello world")).toBe("Hello world");
  });

  it("strips hex address from Cyrillic mentions", () => {
    const hexAddr = "a".repeat(68);
    expect(stripMentionAddresses(`@${hexAddr}:Константин`)).toBe("@Константин");
  });

  it("handles mixed Latin and Cyrillic mentions", () => {
    const hex1 = "a".repeat(68);
    const hex2 = "b".repeat(68);
    const result = stripMentionAddresses(`@${hex1}:Alice and @${hex2}:Борис`);
    expect(result).toBe("@Alice and @Борис");
  });
});

// ─── stripBastyonLinks ────────────────────────────────────────────

describe("stripBastyonLinks", () => {
  it("replaces bastyon:// links with label", () => {
    const txid = "e".repeat(64);
    expect(stripBastyonLinks(`bastyon://post?s=${txid}`)).toContain("Bastyon post");
  });

  it("replaces bastyon.com links with label", () => {
    const txid = "f".repeat(64);
    expect(stripBastyonLinks(`https://bastyon.com/index?v=${txid}`)).toContain("Bastyon post");
  });

  it("returns empty string for empty input", () => {
    expect(stripBastyonLinks("")).toBe("");
  });

  it("returns original text if no bastyon links", () => {
    expect(stripBastyonLinks("Hello world")).toBe("Hello world");
  });
});

// ─── isSafeUrl ───────────────────────────────────────────────────────

describe("isSafeUrl", () => {
  // ─── Allowed URLs ─────────────────────────────────────────────────

  it("allows https://example.com", () => {
    expect(isSafeUrl("https://example.com")).toBe(true);
  });

  it("allows http URL with path and query", () => {
    expect(isSafeUrl("http://example.com/path?q=1")).toBe(true);
  });

  it("allows public IP that looks like private range prefix (172.217.0.1 — Google)", () => {
    expect(isSafeUrl("https://172.217.0.1")).toBe(true);
  });

  // ─── Dangerous schemes ────────────────────────────────────────────

  it("rejects javascript: scheme", () => {
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
  });

  it("rejects data: scheme", () => {
    expect(isSafeUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  // ─── Private / loopback IPs ───────────────────────────────────────

  it("rejects loopback 127.0.0.1", () => {
    expect(isSafeUrl("https://127.0.0.1/admin")).toBe(false);
  });

  it("rejects localhost", () => {
    expect(isSafeUrl("https://localhost:3000")).toBe(false);
  });

  it("rejects 192.168.x.x (private class C)", () => {
    expect(isSafeUrl("https://192.168.1.1")).toBe(false);
  });

  it("rejects 10.x.x.x (private class A)", () => {
    expect(isSafeUrl("https://10.0.0.1")).toBe(false);
  });

  it("rejects 172.16.x.x (private class B start)", () => {
    expect(isSafeUrl("https://172.16.0.1")).toBe(false);
  });

  // ─── Edge cases ───────────────────────────────────────────────────

  it("rejects empty string", () => {
    expect(isSafeUrl("")).toBe(false);
  });

  it("rejects ftp:// (non-http scheme)", () => {
    expect(isSafeUrl("ftp://files.example.com")).toBe(false);
  });
});

// ─── parseMessage + isSafeUrl integration ────────────────────────────

describe("parseMessage URL safety", () => {
  it("does not create link segments for private IPs", () => {
    const segments = parseMessage("Check https://192.168.1.1/admin");
    const links = segments.filter(s => s.type === "link");
    expect(links).toHaveLength(0);
  });

  it("does not create link segments for localhost", () => {
    const segments = parseMessage("Go to https://localhost:3000");
    const links = segments.filter(s => s.type === "link");
    expect(links).toHaveLength(0);
  });

  it("keeps public URLs as link segments", () => {
    const segments = parseMessage("Visit https://example.com now");
    const links = segments.filter(s => s.type === "link");
    expect(links).toHaveLength(1);
  });
});

// ─── truncateMessage ─────────────────────────────────────────────────

describe("truncateMessage", () => {
  it("returns original string when under limit", () => {
    const msg = "Hello world";
    expect(truncateMessage(msg)).toBe(msg);
  });

  it("returns original string at exact limit", () => {
    const msg = "x".repeat(MAX_MESSAGE_LENGTH);
    expect(truncateMessage(msg)).toBe(msg);
    expect(truncateMessage(msg).length).toBe(MAX_MESSAGE_LENGTH);
  });

  it("truncates string exceeding limit", () => {
    const msg = "y".repeat(MAX_MESSAGE_LENGTH + 100);
    const result = truncateMessage(msg);
    expect(result.length).toBe(MAX_MESSAGE_LENGTH);
    expect(result).toBe("y".repeat(MAX_MESSAGE_LENGTH));
  });

  it("handles empty string", () => {
    expect(truncateMessage("")).toBe("");
  });

  it("MAX_MESSAGE_LENGTH equals 65536", () => {
    expect(MAX_MESSAGE_LENGTH).toBe(65536);
  });
});
