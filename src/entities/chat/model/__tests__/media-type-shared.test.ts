import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Samsung 2026-10-12: a video circle received with the app open showed as a
 * plain video — the live-event path mapped m.video on its own and ignored the
 * video-note marker. Both parse paths now use mediaMessageType. Source-level:
 * handleTimelineEvent needs the SDK.
 */
const source = readFileSync(resolve(__dirname, "../chat-store.ts"), "utf-8");

describe("media message type in chat-store", () => {
  it("uses mediaMessageType in the live-event path", () => {
    const live = source.slice(source.indexOf("const handleTimelineEvent = async"), source.indexOf("const handleTimelineEvent = async") + 20000);
    expect(live).toContain("msgType = mediaMessageType(mtype, fileInfo);");
  });

  it("maps m.video by itself nowhere when the file info is known", () => {
    expect(source).not.toMatch(/else if \(mtype === "m\.video"\) msgType = fileInfo\.videoNote/);
    expect(source.match(/msgType = mediaMessageType\(mtype, fileInfo\);/g)).toHaveLength(2);
  });
});
