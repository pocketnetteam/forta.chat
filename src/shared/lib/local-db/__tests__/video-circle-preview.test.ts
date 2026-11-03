import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Review 2026-10-12: a video circle's sidebar preview fell through to the file
 * name on the late-decrypt and repository paths; format-preview renders the
 * "[video message]" token as «🎬 Video message». Source-level.
 */
describe("video circle sidebar preview", () => {
  it("is written as the video-message token on both paths", () => {
    const worker = readFileSync(resolve(__dirname, "../decryption-worker.ts"), "utf-8");
    const repo = readFileSync(resolve(__dirname, "../message-repository.ts"), "utf-8");
    expect(worker).toContain('else if (type === MessageType.videoCircle) preview = "[video message]";');
    expect(repo).toContain('if (type === MessageType.videoCircle) return "[video message]";');
  });
});
