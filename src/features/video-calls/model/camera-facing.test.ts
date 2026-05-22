import { describe, it, expect } from "vitest";
import { isFrontFacingStream, isFrontFacingTrack } from "./camera-facing";

function makeTrack(facingMode: string | undefined): MediaStreamTrack {
  return {
    getSettings: () => (facingMode === undefined ? {} : { facingMode }),
  } as unknown as MediaStreamTrack;
}

function makeStream(facingMode: string | undefined): MediaStream {
  const track = makeTrack(facingMode);
  return {
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
}

describe("isFrontFacingTrack (WEE-36 / forta-bugs#749)", () => {
  it("returns true for user-facing (selfie) camera — local preview must mirror", () => {
    expect(isFrontFacingTrack(makeTrack("user"))).toBe(true);
  });

  it("returns false for back camera — local preview must NOT mirror", () => {
    expect(isFrontFacingTrack(makeTrack("environment"))).toBe(false);
  });

  it("returns false for side-mounted cameras", () => {
    expect(isFrontFacingTrack(makeTrack("left"))).toBe(false);
    expect(isFrontFacingTrack(makeTrack("right"))).toBe(false);
  });

  it("defaults to true when facingMode is missing (desktop webcam)", () => {
    expect(isFrontFacingTrack(makeTrack(undefined))).toBe(true);
  });

  it("returns true when track is null/undefined (no stream yet)", () => {
    expect(isFrontFacingTrack(null)).toBe(true);
    expect(isFrontFacingTrack(undefined)).toBe(true);
  });

  it("returns true when getSettings throws (older WebView)", () => {
    const track = {
      getSettings: () => {
        throw new Error("not supported");
      },
    } as unknown as MediaStreamTrack;
    expect(isFrontFacingTrack(track)).toBe(true);
  });
});

describe("isFrontFacingStream", () => {
  it("inspects the first video track", () => {
    expect(isFrontFacingStream(makeStream("environment"))).toBe(false);
    expect(isFrontFacingStream(makeStream("user"))).toBe(true);
  });

  it("returns true when the stream has no video track", () => {
    const empty = { getVideoTracks: () => [] } as unknown as MediaStream;
    expect(isFrontFacingStream(empty)).toBe(true);
  });

  it("returns true when the stream itself is null", () => {
    expect(isFrontFacingStream(null)).toBe(true);
  });
});
