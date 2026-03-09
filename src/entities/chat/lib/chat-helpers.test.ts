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
import { matrixIdToAddress, messageTypeFromMime, parseFileInfo, looksLikeProperName } from "./chat-helpers";
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

  it("defaults to file for empty string", () => {
    expect(messageTypeFromMime("")).toBe(MessageType.file);
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
    expect(info!.waveform).toEqual([100, 200, 300, 400]);
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
