import { describe, it, expect } from "vitest";
import {
  computeVideoAspectStyle,
  resolveVideoDimensions,
} from "./video-layout";

describe("computeVideoAspectStyle (WEE-36 / forta-bugs#804)", () => {
  it("preserves portrait (9:16) ratio for vertical video", () => {
    const style = computeVideoAspectStyle({ w: 720, h: 1280 });
    expect(style.aspectRatio).toBe("720 / 1280");
  });

  it("preserves landscape ratio for horizontal video", () => {
    const style = computeVideoAspectStyle({ w: 1920, h: 1080 });
    expect(style.aspectRatio).toBe("1920 / 1080");
  });

  it("preserves square ratio", () => {
    const style = computeVideoAspectStyle({ w: 720, h: 720 });
    expect(style.aspectRatio).toBe("720 / 720");
  });

  it("falls back to 16/9 when dimensions are missing", () => {
    expect(computeVideoAspectStyle(null).aspectRatio).toBe("16 / 9");
    expect(computeVideoAspectStyle(undefined).aspectRatio).toBe("16 / 9");
  });

  it("falls back to 16/9 when dimensions are non-positive", () => {
    expect(computeVideoAspectStyle({ w: 0, h: 1280 }).aspectRatio).toBe("16 / 9");
    expect(computeVideoAspectStyle({ w: 720, h: 0 }).aspectRatio).toBe("16 / 9");
    expect(computeVideoAspectStyle({ w: -1, h: -1 }).aspectRatio).toBe("16 / 9");
  });
});

describe("resolveVideoDimensions", () => {
  it("prefers fileInfo dimensions when present", () => {
    expect(
      resolveVideoDimensions({ w: 720, h: 1280 }, { w: 1920, h: 1080 }),
    ).toEqual({ w: 720, h: 1280 });
  });

  it("falls back to natural dimensions when fileInfo is missing", () => {
    expect(resolveVideoDimensions(null, { w: 720, h: 1280 })).toEqual({
      w: 720,
      h: 1280,
    });
  });

  it("falls back to natural dimensions when fileInfo has zero values", () => {
    expect(
      resolveVideoDimensions({ w: 0, h: 0 }, { w: 720, h: 1280 }),
    ).toEqual({ w: 720, h: 1280 });
  });

  it("returns null when neither source has usable dimensions", () => {
    expect(resolveVideoDimensions(null, null)).toBeNull();
    expect(
      resolveVideoDimensions({ w: 0, h: 0 }, { w: 0, h: 0 }),
    ).toBeNull();
  });
});
