import { describe, it, expect } from "vitest";
import {
  isVideoNoteInfo,
  MSC3245_VIDEO_NOTE_KEY,
} from "../chat-helpers";

/**
 * WEE-51 / forta-bugs#837 — Video-note "circle" was arriving as a square
 * on the receiver side because the sender stamped only a non-standard
 * `videoNote: true` flag inside `content.info`. Other Matrix clients
 * (and our own users coming back from a long-running session) rely on the
 * MSC3245 standard key `org.matrix.msc3245.video_note`. The parser must
 * accept either signal; the writer must emit both for interop.
 */
describe("video-note MSC3245 metadata interop", () => {
  it("exposes the MSC3245 key as the canonical constant", () => {
    expect(MSC3245_VIDEO_NOTE_KEY).toBe("org.matrix.msc3245.video_note");
  });

  it("treats legacy `videoNote: true` as a video-note", () => {
    expect(isVideoNoteInfo({ videoNote: true })).toBe(true);
  });

  it("treats standard MSC3245 flag as a video-note", () => {
    expect(isVideoNoteInfo({ [MSC3245_VIDEO_NOTE_KEY]: true })).toBe(true);
  });

  it("treats both flags together as a video-note (sender writes both for interop)", () => {
    expect(
      isVideoNoteInfo({
        videoNote: true,
        [MSC3245_VIDEO_NOTE_KEY]: true,
      }),
    ).toBe(true);
  });

  it("does not classify a regular m.video info bag as a video-note", () => {
    expect(isVideoNoteInfo({ mimetype: "video/mp4", size: 1234 })).toBe(false);
  });

  it("returns false for nullish / undefined info bags", () => {
    expect(isVideoNoteInfo(undefined)).toBe(false);
    expect(isVideoNoteInfo(null)).toBe(false);
  });

  it("ignores non-boolean truthy values (defensive: foreign clients may send strings)", () => {
    // We only accept literal `true` — a stringified "true" or "1" should not
    // be misinterpreted as a circle, because the receiver applies a CSS mask
    // that disfigures a regular landscape video.
    expect(isVideoNoteInfo({ videoNote: "true" as unknown as boolean })).toBe(false);
    expect(isVideoNoteInfo({ [MSC3245_VIDEO_NOTE_KEY]: 1 as unknown as boolean })).toBe(false);
  });
});
