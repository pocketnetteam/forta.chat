/**
 * Tests for critical chat helper functions.
 *
 * matrixIdToAddress — the most critical conversion in the app.
 *   A bug here caused: own messages not recognized, avatars not loading,
 *   reactions attributed to wrong users, typing indicators broken.
 *
 * messageTypeFromMime — determines how messages are rendered.
 *
 * parseFileInfo — extracts file metadata for decryption and display.
 *   A bug here breaks: encrypted file decryption, image/video rendering.
 */
import { describe, it, expect } from "vitest";
import { matrixIdToAddress, messageTypeFromMime, normalizeMime, parseFileInfo, looksLikeProperName, resolveSystemText, isUnresolvedName, cleanMatrixIds, formatGroupMemberNames } from "./chat-helpers";
import { hexEncode } from "@/shared/lib/matrix/functions";
import { MessageType } from "../model/types";

// ─── matrixIdToAddress ───────────────────────────────────────────

describe("matrixIdToAddress", () => {
  const RAW_ADDR = "PPbNqCweFnTePQyXWR21B9jXWCiDJa2yYu";
  const HEX_ADDR = hexEncode(RAW_ADDR).toLowerCase();

  it("converts full Matrix user ID to raw Bastyon address", () => {
    const matrixId = `@${HEX_ADDR}:matrix.pocketnet.app`;
    expect(matrixIdToAddress(matrixId)).toBe(RAW_ADDR);
  });

  it("converts bare hex string (no @ or :) to raw address", () => {
    expect(matrixIdToAddress(HEX_ADDR)).toBe(RAW_ADDR);
  });

  it("result can be used to look up Pocketnet user profiles", () => {
    const matrixId = `@${HEX_ADDR}:matrix.pocketnet.app`;
    const addr = matrixIdToAddress(matrixId);
    // Raw Bastyon address: starts with P, is 34 chars
    expect(addr).toMatch(/^P[a-zA-Z0-9]{33}$/);
  });

  it("handles multiple real addresses", () => {
    const addresses = [
      "PPbNqCweFnTePQyXWR21B9jXWCiDJa2yYu",
      "PHxLqCwAG4s2G9DmNHHWxMXXm77EkzqJUf",
      "P9hB2dZ7YLfDGGBDYRwn6u38AQ6cNg12Rx",
    ];

    for (const raw of addresses) {
      const hex = hexEncode(raw).toLowerCase();
      const matrixId = `@${hex}:server`;
      expect(matrixIdToAddress(matrixId)).toBe(raw);
    }
  });

  it("returns empty string for empty input", () => {
    expect(matrixIdToAddress("")).toBe("");
  });
});

// ─── Crypto event sender encoding ───────────────────────────────

describe("crypto sender encoding (regression: emptykey bug)", () => {
  it("hex-encoding a raw address produces the Matrix username format", () => {
    const rawAddr = "PPbNqCweFnTePQyXWR21B9jXWCiDJa2yYu";
    const hexAddr = hexEncode(rawAddr).toLowerCase();

    // This is what the crypto decryptKey expects as sender
    // (after getmatrixid strips @ and :server)
    expect(hexAddr).toMatch(/^[0-9a-f]+$/);
    expect(hexAddr.length).toBe(rawAddr.length * 2);
  });

  it("matrixIdToAddress output differs from hex format (raw vs hex)", () => {
    const rawAddr = "PPbNqCweFnTePQyXWR21B9jXWCiDJa2yYu";
    const hexAddr = hexEncode(rawAddr).toLowerCase();
    const matrixId = `@${hexAddr}:server`;

    // matrixIdToAddress returns RAW — must NOT be passed to decryptKey
    const decoded = matrixIdToAddress(matrixId);
    expect(decoded).toBe(rawAddr);
    expect(decoded).not.toBe(hexAddr); // Critical: these are different!
  });

  it("for decryption: raw address must be re-encoded to hex", () => {
    const rawAddr = "PPbNqCweFnTePQyXWR21B9jXWCiDJa2yYu";
    const hexAddr = hexEncode(rawAddr).toLowerCase();

    // Simulates what use-file-download must do for the fake event
    const sender = hexEncode(rawAddr).toLowerCase();
    expect(sender).toBe(hexAddr);
  });
});

// ─── normalizeMime ───────────────────────────────────────────────

describe("normalizeMime", () => {
  it("returns valid MIME as-is", () => {
    expect(normalizeMime("image/jpeg")).toBe("image/jpeg");
    expect(normalizeMime("application/pdf")).toBe("application/pdf");
    expect(normalizeMime("application/vnd.android.package-archive")).toBe("application/vnd.android.package-archive");
  });

  it("falls back to application/octet-stream for empty string", () => {
    expect(normalizeMime("")).toBe("application/octet-stream");
  });

  it("falls back to application/octet-stream for undefined", () => {
    expect(normalizeMime(undefined)).toBe("application/octet-stream");
  });

  it("falls back for malformed MIME without slash", () => {
    expect(normalizeMime("apk")).toBe("application/octet-stream");
    expect(normalizeMime("fb2")).toBe("application/octet-stream");
  });
});

// ─── messageTypeFromMime ─────────────────────────────────────────

describe("messageTypeFromMime", () => {
  it("detects image types", () => {
    expect(messageTypeFromMime("image/jpeg")).toBe(MessageType.image);
    expect(messageTypeFromMime("image/png")).toBe(MessageType.image);
    expect(messageTypeFromMime("image/webp")).toBe(MessageType.image);
  });

  it("detects video types", () => {
    expect(messageTypeFromMime("video/mp4")).toBe(MessageType.video);
    expect(messageTypeFromMime("video/webm")).toBe(MessageType.video);
  });

  it("detects audio types", () => {
    expect(messageTypeFromMime("audio/webm")).toBe(MessageType.audio);
    expect(messageTypeFromMime("audio/mpeg")).toBe(MessageType.audio);
    expect(messageTypeFromMime("audio/ogg")).toBe(MessageType.audio);
  });

  it("defaults to file for unknown MIME", () => {
    expect(messageTypeFromMime("application/pdf")).toBe(MessageType.file);
    expect(messageTypeFromMime("text/plain")).toBe(MessageType.file);
  });

  it("defaults to file for empty string (via normalizeMime fallback)", () => {
    expect(messageTypeFromMime("")).toBe(MessageType.file);
  });

  it("classifies generic types (.apk, .fb2) as file", () => {
    expect(messageTypeFromMime("application/vnd.android.package-archive")).toBe(MessageType.file);
    expect(messageTypeFromMime("application/x-fictionbook+xml")).toBe(MessageType.file);
    expect(messageTypeFromMime("application/octet-stream")).toBe(MessageType.file);
  });
});

// ─── parseFileInfo ───────────────────────────────────────────────

describe("parseFileInfo", () => {
  it("parses m.file with pbody (standard encrypted file)", () => {
    const content = {
      pbody: {
        name: "photo.jpg",
        type: "encrypted/image/jpeg",
        size: 12345,
        url: "https://matrix.server/file/abc",
        secrets: { block: 100, keys: "base64keys", v: 1 },
      },
    };

    const info = parseFileInfo(content, "m.file");
    expect(info).toBeDefined();
    expect(info!.name).toBe("photo.jpg");
    expect(info!.type).toBe("image/jpeg"); // encrypted/ prefix stripped
    expect(info!.size).toBe(12345);
    expect(info!.url).toBe("https://matrix.server/file/abc");
    expect(info!.secrets).toEqual({ block: 100, keys: "base64keys", v: 1 });
  });

  it("strips encrypted/ prefix from MIME type", () => {
    const content = {
      pbody: {
        name: "doc.pdf",
        type: "encrypted/application/pdf",
        size: 1000,
        url: "https://url",
      },
    };

    const info = parseFileInfo(content, "m.file");
    expect(info!.type).toBe("application/pdf");
  });

  it("parses m.file from JSON body (fallback path)", () => {
    const content = {
      body: JSON.stringify({
        name: "audio.webm",
        type: "audio/webm",
        size: 5000,
        url: "https://matrix.server/file/xyz",
      }),
    };

    const info = parseFileInfo(content, "m.file");
    expect(info).toBeDefined();
    expect(info!.name).toBe("audio.webm");
    expect(info!.url).toBe("https://matrix.server/file/xyz");
  });

  it("parses m.image with info block", () => {
    const content = {
      body: "sunset.png",
      info: {
        mimetype: "image/png",
        size: 50000,
        url: "https://matrix.server/image/123",
        w: 1920,
        h: 1080,
        secrets: { block: 200, keys: "imgkeys", version: 2 },
      },
    };

    const info = parseFileInfo(content, "m.image");
    expect(info).toBeDefined();
    expect(info!.name).toBe("sunset.png");
    expect(info!.type).toBe("image/png");
    expect(info!.w).toBe(1920);
    expect(info!.h).toBe(1080);
    expect(info!.secrets!.v).toBe(2); // version → v normalization
  });

  it("returns undefined for m.text", () => {
    expect(parseFileInfo({ body: "hello" }, "m.text")).toBeUndefined();
  });

  it("returns undefined for m.file without parseable content", () => {
    expect(parseFileInfo({ body: "not json" }, "m.file")).toBeUndefined();
  });

  it("handles missing secrets gracefully", () => {
    const content = {
      pbody: {
        name: "file.txt",
        type: "text/plain",
        size: 100,
        url: "https://url",
      },
    };

    const info = parseFileInfo(content, "m.file");
    expect(info).toBeDefined();
    expect(info!.secrets).toBeUndefined();
  });

  it("normalizes secrets.version → secrets.v", () => {
    const content = {
      pbody: {
        name: "f",
        type: "t",
        size: 0,
        url: "u",
        secrets: { block: 1, keys: "k", version: 3 },
      },
    };

    const info = parseFileInfo(content, "m.file");
    expect(info!.secrets!.v).toBe(3);
  });

  // ─── m.audio ────────────────────────────────────────────────────

  it("parses m.audio with duration (ms → sec conversion)", () => {
    const content = {
      body: "voice.ogg",
      info: {
        mimetype: "audio/ogg",
        size: 8000,
        url: "https://matrix.server/audio/1",
        duration: 45000, // 45 seconds in ms
        waveform: [100, 200, 300, 400],
        secrets: { block: 10, keys: "audiokeys", v: 1 },
      },
    };
    const info = parseFileInfo(content, "m.audio");
    expect(info).toBeDefined();
    expect(info!.duration).toBe(45);
    // Waveform values >1 are normalized from 0-1024 to 0-1
    expect(info!.waveform).toEqual([100 / 1024, 200 / 1024, 300 / 1024, 400 / 1024]);
    expect(info!.secrets).toEqual({ block: 10, keys: "audiokeys", v: 1 });
  });

  it("parses m.audio without duration gracefully", () => {
    const content = {
      body: "clip.mp3",
      info: { mimetype: "audio/mpeg", size: 3000, url: "https://url" },
    };
    const info = parseFileInfo(content, "m.audio");
    expect(info).toBeDefined();
    expect(info!.duration).toBeUndefined();
    expect(info!.waveform).toBeUndefined();
  });

  // ─── m.video ────────────────────────────────────────────────────

  it("parses m.video with dimensions and duration", () => {
    const content = {
      body: "clip.mp4",
      info: {
        mimetype: "video/mp4",
        size: 500000,
        url: "https://matrix.server/video/1",
        w: 1280,
        h: 720,
        duration: 120000, // 120 seconds in ms
        secrets: { block: 50, keys: "vidkeys", v: 2 },
      },
    };
    const info = parseFileInfo(content, "m.video");
    expect(info).toBeDefined();
    expect(info!.w).toBe(1280);
    expect(info!.h).toBe(720);
    expect(info!.duration).toBe(120);
    expect(info!.secrets).toEqual({ block: 50, keys: "vidkeys", v: 2 });
  });

  it("parses m.video with url in content (not info)", () => {
    const content = {
      body: "movie.webm",
      url: "https://matrix.server/video/fallback",
    };
    const info = parseFileInfo(content, "m.video");
    expect(info).toBeDefined();
    expect(info!.url).toBe("https://matrix.server/video/fallback");
  });
});

// ─── looksLikeProperName ──────────────────────────────────────────

describe("looksLikeProperName", () => {
  it("accepts normal human-readable names", () => {
    expect(looksLikeProperName("Alice")).toBe(true);
    expect(looksLikeProperName("Боб")).toBe(true);
    expect(looksLikeProperName("John_Doe")).toBe(true);
  });

  it("rejects hex strings", () => {
    expect(looksLikeProperName("5050624e714377")).toBe(false);
    expect(looksLikeProperName("abcdef1234")).toBe(false);
  });

  it("rejects Matrix IDs (starting with @)", () => {
    expect(looksLikeProperName("@user:server")).toBe(false);
  });

  it("rejects room IDs (starting with !)", () => {
    expect(looksLikeProperName("!room:server")).toBe(false);
  });

  it("rejects room aliases (starting with #)", () => {
    expect(looksLikeProperName("#general:server")).toBe(false);
  });

  it("rejects short strings (< 2 chars)", () => {
    expect(looksLikeProperName("A")).toBe(false);
    expect(looksLikeProperName("")).toBe(false);
  });

  it("rejects name matching raw Bastyon address", () => {
    const addr = "PPbNqCweFnTePQyXWR21B9jXWCiDJa2yYu";
    expect(looksLikeProperName(addr, addr)).toBe(false);
  });

  it("accepts name that differs from raw address", () => {
    expect(looksLikeProperName("Alice", "PPbNqCweFnTePQyXWR21B9jXWCiDJa2yYu")).toBe(true);
  });
});

// ─── resolveSystemText ──────────────────────────────────────────

describe("resolveSystemText", () => {
  const mockT = (key: string, params?: Record<string, string | number>) => {
    const templates: Record<string, string> = {
      "system.joined": "{sender} joined the chat",
      "system.removed": "{sender} removed {target}",
      "system.changedName": "{sender} changed the room name to \"{name}\"",
      "system.unknownEvent": "System event",
      "system.missedVideoCall": "Missed video call",
    };
    let text = templates[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
      }
    }
    return text;
  };
  const resolveName = (addr: string) => addr === "alice_addr" ? "Alice" : addr === "bob_addr" ? "Bob" : addr;

  it("resolves i18n key with sender name", () => {
    const result = resolveSystemText("system.joined", "alice_addr", undefined, resolveName, mockT);
    expect(result).toBe("Alice joined the chat");
  });

  it("resolves i18n key with sender and target", () => {
    const result = resolveSystemText("system.removed", "alice_addr", "bob_addr", resolveName, mockT);
    expect(result).toBe("Alice removed Bob");
  });

  it("resolves i18n key with extra params", () => {
    const result = resolveSystemText("system.changedName", "alice_addr", undefined, resolveName, mockT, { name: "General" });
    expect(result).toBe("Alice changed the room name to \"General\"");
  });

  it("resolves call template without sender/target placeholders", () => {
    const result = resolveSystemText("system.missedVideoCall", "alice_addr", undefined, resolveName, mockT);
    expect(result).toBe("Missed video call");
  });

  it("falls back to legacy template when no t() provided", () => {
    const result = resolveSystemText("{sender} joined the chat", "alice_addr", undefined, resolveName);
    expect(result).toBe("Alice joined the chat");
  });

  it("falls back to legacy template when template is not an i18n key", () => {
    const result = resolveSystemText("{sender} left the chat", "alice_addr", undefined, resolveName, mockT);
    expect(result).toBe("Alice left the chat");
  });

  it("returns raw key when i18n key is unknown", () => {
    const result = resolveSystemText("system.nonexistent", "alice_addr", undefined, resolveName, mockT);
    expect(result).toBe("system.nonexistent");
  });

  it("resolver can show 'Unknown User' for short addresses without profile", () => {
    // Simulates the format-preview resolver pattern: if getDisplayName returns
    // the raw address AND no profile is loaded, show "Unknown User".
    const profileCache: Record<string, string> = {};
    const resolveWithProfileCheck = (addr: string) => {
      const name = addr === "alice_addr" ? "Alice" : addr; // getDisplayName fallback
      if (isUnresolvedName(name)) return "Unknown User";
      if (name === addr && !profileCache[addr]) return "Unknown User";
      return name;
    };

    // Known user — resolved from Matrix SDK
    const result1 = resolveSystemText("system.joined", "alice_addr", undefined, resolveWithProfileCheck, mockT);
    expect(result1).toBe("Alice joined the chat");

    // Short address, no profile — should show "Unknown User"
    const result2 = resolveSystemText("system.joined", "maxgr", undefined, resolveWithProfileCheck, mockT);
    expect(result2).toBe("Unknown User joined the chat");

    // Short address, profile loaded — should show profile name (even if same as addr)
    profileCache["maxgr"] = "maxgr";
    const result3 = resolveSystemText("system.joined", "maxgr", undefined, resolveWithProfileCheck, mockT);
    expect(result3).toBe("maxgr joined the chat");
  });
});

// ─── isUnresolvedName ───────────────────────────────────────────

describe("isUnresolvedName", () => {
  it("detects hex hash strings", () => {
    expect(isUnresolvedName("5053634c4b526232517a4232674d76766b4a47")).toBe(true);
  });

  it("detects truncated hex (8chars…)", () => {
    expect(isUnresolvedName("5053634c\u2026566f")).toBe(true);
  });

  it("detects raw Matrix ID", () => {
    expect(isUnresolvedName("@5053634c4b526232517a4232:server")).toBe(true);
  });

  it("detects raw Bastyon address (base58, 20+ chars)", () => {
    expect(isUnresolvedName("PPbNqCweFnTePQyXWR21B9jXWCiDJa2yYu")).toBe(true);
  });

  it("detects empty/short names", () => {
    expect(isUnresolvedName("")).toBe(true);
    expect(isUnresolvedName("A")).toBe(true);
  });

  it("accepts human-readable names", () => {
    expect(isUnresolvedName("Alice")).toBe(false);
    expect(isUnresolvedName("Боб")).toBe(false);
    expect(isUnresolvedName("John_Doe")).toBe(false);
    expect(isUnresolvedName("Perehvat_Upravleniya")).toBe(false);
  });

  it("does NOT detect short Bastyon usernames as unresolved (pattern-based only)", () => {
    // Short alphanumeric addresses like "maxgr" or "alice" pass isUnresolvedName.
    // The caller (format-preview) must apply an additional check (name === addr
    // && no profile loaded) to correctly handle this case.
    expect(isUnresolvedName("maxgr")).toBe(false);
    expect(isUnresolvedName("alice")).toBe(false);
    expect(isUnresolvedName("bob123")).toBe(false);
  });
});

// ─── cleanMatrixIds ─────────────────────────────────────────────

describe("cleanMatrixIds", () => {
  it("replaces @hexid:server with decoded address", () => {
    const addr = "PPbNqCweFnTePQyXWR21B9jXWCiDJa2yYu";
    const hex = hexEncode(addr).toLowerCase();
    const result = cleanMatrixIds(`@${hex}:server left the chat`);
    expect(result).toBe(`${addr} left the chat`);
  });

  it("replaces bare hex strings (40+ chars) with decoded address", () => {
    const addr = "PPbNqCweFnTePQyXWR21B9jXWCiDJa2yYu";
    const hex = hexEncode(addr).toLowerCase();
    const result = cleanMatrixIds(`${hex} joined the chat`);
    expect(result).toBe(`${addr} joined the chat`);
  });

  it("truncates undecodable hex strings", () => {
    // 50 chars of hex that don't decode to valid base58
    const badHex = "aa".repeat(25);
    const result = cleanMatrixIds(`${badHex} did something`);
    expect(result).toContain("\u2026");
    expect(result).not.toContain(badHex);
  });

  it("returns text unchanged when no hex patterns present", () => {
    expect(cleanMatrixIds("Alice joined the chat")).toBe("Alice joined the chat");
  });
});

// ─── matrixIdToAddress: non-printable char validation ───────────

describe("matrixIdToAddress — non-printable character validation", () => {
  it("returns hex fallback when decoded string has non-printable chars", () => {
    // Hex that decodes to string with control characters
    // \x17 = 0x17 (ETB), encoded as hex pair "17"
    const hexWithControlChar = "4141" + "17" + "4242"; // "AA\x17BB"
    const result = matrixIdToAddress(`@${hexWithControlChar}:server`);
    // Should NOT contain control characters — should return the hex part
    expect(/^[A-Za-z0-9]+$/.test(result)).toBe(true);
  });

  it("returns valid decoded address for proper hex input", () => {
    const addr = "PPbNqCweFnTePQyXWR21B9jXWCiDJa2yYu";
    const hex = hexEncode(addr).toLowerCase();
    expect(matrixIdToAddress(`@${hex}:server`)).toBe(addr);
  });
});

// ─── formatGroupMemberNames ─────────────────────────────────────

describe("formatGroupMemberNames", () => {
  it("returns empty string for empty array", () => {
    expect(formatGroupMemberNames([])).toBe("");
  });

  it("returns single name without ellipsis", () => {
    expect(formatGroupMemberNames(["Alice"])).toBe("Alice");
  });

  it("joins up to 5 names with commas", () => {
    const names = ["Alice", "Bob", "Carol", "Dave", "Eve"];
    expect(formatGroupMemberNames(names)).toBe("Alice, Bob, Carol, Dave, Eve");
  });

  it("truncates at 5 names and appends ellipsis", () => {
    const names = ["Alice", "Bob", "Carol", "Dave", "Eve", "Frank"];
    expect(formatGroupMemberNames(names)).toBe("Alice, Bob, Carol, Dave, Eve, …");
  });

  it("truncates many names at 5", () => {
    const names = Array.from({ length: 20 }, (_, i) => `User${i + 1}`);
    expect(formatGroupMemberNames(names)).toBe("User1, User2, User3, User4, User5, …");
  });

  it("handles exactly 5 names without ellipsis", () => {
    const names = ["A", "B", "C", "D", "E"];
    expect(formatGroupMemberNames(names)).toBe("A, B, C, D, E");
  });
});
