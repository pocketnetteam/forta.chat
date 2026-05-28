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
import { matrixIdToAddress, messageTypeFromMime, normalizeMime, parseFileInfo, looksLikeProperName, resolveSystemText, isUnresolvedName, cleanMatrixIds, isVoiceAudioContent, MSC3245_VOICE_KEY } from "./chat-helpers";
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

  // ─── m.audio voice vs file (WEE-50 / forta-bugs#841) ───────────
  // The voice player UI must only render for actual voice recordings.
  // Generic audio attachments (MP3 from gallery, podcasts, …) must be
  // surfaced as files with a save-to-disk affordance.

  it("flags m.audio with MSC3245 voice marker as a voice recording", () => {
    const content = {
      body: "voice.ogg",
      [MSC3245_VOICE_KEY]: {},
      info: { mimetype: "audio/ogg", size: 4000, url: "https://url", duration: 5000 },
    };
    const info = parseFileInfo(content, "m.audio");
    expect(info!.isVoice).toBe(true);
  });

  it("flags m.audio with waveform as a voice recording (legacy fallback)", () => {
    const content = {
      body: "voice.ogg",
      info: { mimetype: "audio/ogg", size: 4000, url: "https://url", duration: 5000, waveform: [100, 200, 300] },
    };
    const info = parseFileInfo(content, "m.audio");
    expect(info!.isVoice).toBe(true);
  });

  it("does NOT flag plain m.audio MP3 (gallery attachment) as a voice recording", () => {
    const content = {
      body: "song.mp3",
      info: { mimetype: "audio/mpeg", size: 3000, url: "https://url" },
    };
    const info = parseFileInfo(content, "m.audio");
    expect(info!.isVoice).toBe(false);
  });

  // m.file is never a voice recording — Forta ships gallery picks as m.file
  // regardless of MIME, so the receiver-side decoder must NOT treat audio
  // MIME under m.file as a voice message (forta-bugs#841 / WEE-50).
  it("never flags m.file as voice (pbody path)", () => {
    const content = {
      pbody: { name: "song.mp3", type: "audio/mpeg", size: 3000, url: "https://url" },
    };
    const info = parseFileInfo(content, "m.file");
    expect(info!.isVoice).toBe(false);
  });

  it("never flags m.file as voice (JSON-body path)", () => {
    const content = {
      body: JSON.stringify({ name: "track.m4a", type: "audio/mp4", size: 5000, url: "https://url" }),
    };
    const info = parseFileInfo(content, "m.file");
    expect(info!.isVoice).toBe(false);
  });

  it("never flags m.file as voice (canonical Matrix encrypted-file path)", () => {
    const content = {
      body: "podcast.mp3",
      file: { url: "mxc://server/abc", mimetype: "audio/mpeg" },
      info: { mimetype: "audio/mpeg", size: 200 },
    };
    const info = parseFileInfo(content, "m.file");
    expect(info!.isVoice).toBe(false);
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

// ─── parseFileInfo — encrypted attachment via content.file.url (Session 57) ───
// Canonical Matrix encrypted attachments carry url under `content.file.url`
// alongside { iv, key }. Some non-Bastyon clients (Element, Cinny, FluffyChat)
// emit m.image/m.audio/m.video/m.file without copying that url to
// `content.url` / `content.info.url`. Forta must read content.file.url as a
// fallback or tap «Download» throws "No file URL" and opens a bug-report.

describe("parseFileInfo — encrypted attachment (content.file.url fallback)", () => {
  it("reads url from content.file.url when content.url and info.url are missing (m.file)", () => {
    const content = {
      msgtype: "m.file",
      body: "report.pdf",
      file: {
        url: "mxc://matrix.bastyon.com/abc123",
        mimetype: "application/pdf",
        key: { kty: "oct", k: "..." },
        iv: "...",
      },
      info: { mimetype: "application/pdf", size: 12345 },
    };
    const fi = parseFileInfo(content, "m.file");
    expect(fi).toBeDefined();
    expect(fi!.url).toBe("mxc://matrix.bastyon.com/abc123");
  });

  it("reads url from content.file.url for m.image", () => {
    const content = {
      body: "photo.jpg",
      file: { url: "mxc://server/img1", mimetype: "image/jpeg" },
      info: { mimetype: "image/jpeg", w: 100, h: 200 },
    };
    const fi = parseFileInfo(content, "m.image");
    expect(fi).toBeDefined();
    expect(fi!.url).toBe("mxc://server/img1");
  });

  it("reads url from content.file.url for m.audio", () => {
    const content = {
      body: "voice.opus",
      file: { url: "mxc://server/aud1", mimetype: "audio/opus" },
      info: { mimetype: "audio/opus", duration: 5000 },
    };
    const fi = parseFileInfo(content, "m.audio");
    expect(fi).toBeDefined();
    expect(fi!.url).toBe("mxc://server/aud1");
  });

  it("reads url from content.file.url for m.video", () => {
    const content = {
      body: "video.mp4",
      file: { url: "mxc://server/vid1", mimetype: "video/mp4" },
      info: { mimetype: "video/mp4", w: 1920, h: 1080 },
    };
    const fi = parseFileInfo(content, "m.video");
    expect(fi).toBeDefined();
    expect(fi!.url).toBe("mxc://server/vid1");
  });

  it("prefers info.url over content.file.url when both present (m.image)", () => {
    const content = {
      body: "x.jpg",
      file: { url: "mxc://server/from-file" },
      info: { mimetype: "image/jpeg", url: "mxc://server/from-info", w: 1, h: 1 },
    };
    const fi = parseFileInfo(content, "m.image");
    expect(fi!.url).toBe("mxc://server/from-info");
  });

  it("prefers pbody.url over content.file.url when both present (m.file)", () => {
    const content = {
      pbody: { name: "x.pdf", type: "application/pdf", size: 0, url: "mxc://server/from-pbody" },
      file: { url: "mxc://server/from-file" },
    };
    const fi = parseFileInfo(content, "m.file");
    expect(fi!.url).toBe("mxc://server/from-pbody");
  });

  it("m.file without pbody but with content.file.url returns valid FileInfo", () => {
    // No pbody → first branch skipped; second branch (body-as-JSON) also fails.
    // Need a third branch that handles raw m.file with content.file.url.
    const content = {
      body: "report.pdf",
      file: {
        url: "mxc://matrix.bastyon.com/abc123",
        mimetype: "application/pdf",
        key: { kty: "oct", k: "..." },
        iv: "...",
      },
      info: { mimetype: "application/pdf", size: 12345 },
    };
    const fi = parseFileInfo(content, "m.file");
    expect(fi).toBeDefined();
    expect(fi!.url).toBe("mxc://matrix.bastyon.com/abc123");
  });
});

// ─── parseFileInfo — filename normalization (Session 53) ──────────

describe("parseFileInfo — filename normalization by mime", () => {
  it("adds .jpg when m.image body has no extension", () => {
    const fi = parseFileInfo(
      {
        body: "Image",
        info: { mimetype: "image/jpeg", size: 100, url: "mxc://x", w: 100, h: 100 },
      },
      "m.image",
    );
    expect(fi?.name).toBe("Image.jpg");
  });

  it("keeps existing extension when present", () => {
    const fi = parseFileInfo(
      {
        body: "screenshot.png",
        info: { mimetype: "image/png", size: 100, url: "mxc://x", w: 100, h: 100 },
      },
      "m.image",
    );
    expect(fi?.name).toBe("screenshot.png");
  });

  it("adds .mp4 for m.video without extension", () => {
    const fi = parseFileInfo(
      {
        body: "Video",
        info: { mimetype: "video/mp4", size: 100, url: "mxc://x" },
      },
      "m.video",
    );
    expect(fi?.name).toBe("Video.mp4");
  });

  it("adds .mp3 for m.audio without extension", () => {
    const fi = parseFileInfo(
      {
        body: "Audio",
        info: { mimetype: "audio/mpeg", size: 100, url: "mxc://x" },
      },
      "m.audio",
    );
    expect(fi?.name).toBe("Audio.mp3");
  });

  it("falls back to .bin for unknown mime", () => {
    const fi = parseFileInfo(
      {
        body: "blob",
        info: { mimetype: "application/x-foo", size: 100, url: "mxc://x", w: 1, h: 1 },
      },
      "m.image",
    );
    expect(fi?.name).toBe("blob.bin");
  });

  it("strips encrypted/ prefix from mime when picking extension", () => {
    const fi = parseFileInfo(
      {
        body: "Image",
        info: { mimetype: "encrypted/image/png", size: 100, url: "mxc://x", w: 1, h: 1 },
      },
      "m.image",
    );
    expect(fi?.name).toBe("Image.png");
  });

  it("treats numeric trailing segment as non-extension (holiday.2024)", () => {
    // Without alpha-first guard "holiday.2024" looks like it already has an
    // extension and saves without .jpg. Tighter regex restores .jpg.
    const fi = parseFileInfo(
      {
        body: "holiday.2024",
        info: { mimetype: "image/jpeg", size: 100, url: "mxc://x", w: 1, h: 1 },
      },
      "m.image",
    );
    expect(fi?.name).toBe("holiday.2024.jpg");
  });

  it("strips MIME parameters before mapping to extension", () => {
    // "image/jpeg; charset=binary" must still resolve to .jpg, not .bin.
    const fi = parseFileInfo(
      {
        body: "Image",
        info: { mimetype: "image/jpeg; charset=binary", size: 100, url: "mxc://x", w: 1, h: 1 },
      },
      "m.image",
    );
    expect(fi?.name).toBe("Image.jpg");
  });

  it("uses default name stem when body is empty string", () => {
    // "" ?? "image" returned "" — file then saved as ".jpg" with no stem.
    const fi = parseFileInfo(
      {
        body: "",
        info: { mimetype: "image/jpeg", size: 100, url: "mxc://x", w: 1, h: 1 },
      },
      "m.image",
    );
    expect(fi?.name).toBe("image.jpg");
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

// ─── isVoiceAudioContent — voice recording vs audio file (WEE-50) ───
//
// The audio-rendering branch in MessageBubble.vue decides between
// VoiceMessage and the generic file bubble using this helper. Misclassifying
// an MP3 picked from the gallery as a voice message (forta-bugs#841) hides
// the save-to-disk button and presents a player UI with no waveform — so
// this test set has to lock down both directions of the boundary.

describe("isVoiceAudioContent", () => {
  it("returns true when the MSC3245 voice marker is on the content", () => {
    expect(isVoiceAudioContent({ [MSC3245_VOICE_KEY]: {} }, null)).toBe(true);
  });

  it("returns true when the MSC3245 voice marker is on info", () => {
    expect(isVoiceAudioContent(null, { [MSC3245_VOICE_KEY]: {} })).toBe(true);
  });

  it("returns true when info has a non-empty waveform (legacy fallback)", () => {
    expect(isVoiceAudioContent({}, { waveform: [1, 2, 3] })).toBe(true);
  });

  it("returns false when neither marker nor waveform present", () => {
    expect(isVoiceAudioContent({}, { mimetype: "audio/mpeg" })).toBe(false);
  });

  it("returns false for an empty waveform array (heuristic safety)", () => {
    expect(isVoiceAudioContent({}, { waveform: [] })).toBe(false);
  });

  it("returns false when both inputs are null", () => {
    expect(isVoiceAudioContent(null, null)).toBe(false);
  });
});
