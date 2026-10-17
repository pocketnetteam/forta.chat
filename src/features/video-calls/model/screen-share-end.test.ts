import { describe, it, expect, vi } from "vitest";
import { onScreenShareEnded } from "./screen-share-end";

function fakeStream(trackCount = 1) {
  const tracks = Array.from({ length: trackCount }, () => new EventTarget());
  return {
    tracks,
    stream: { getVideoTracks: () => tracks } as unknown as MediaStream,
  };
}

describe("onScreenShareEnded", () => {
  it("fires once when the browser ends the capture track", () => {
    const { tracks, stream } = fakeStream();
    const onEnded = vi.fn();
    onScreenShareEnded(stream, onEnded);
    tracks[0].dispatchEvent(new Event("ended"));
    tracks[0].dispatchEvent(new Event("ended"));
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it("does not fire after the disposer ran", () => {
    const { tracks, stream } = fakeStream();
    const onEnded = vi.fn();
    const dispose = onScreenShareEnded(stream, onEnded);
    dispose();
    tracks[0].dispatchEvent(new Event("ended"));
    expect(onEnded).not.toHaveBeenCalled();
  });

  it("is a no-op without a stream", () => {
    expect(() => onScreenShareEnded(undefined, vi.fn())()).not.toThrow();
  });

  it("fires at once for a track the browser already ended", () => {
    const track = Object.assign(new EventTarget(), { readyState: "ended" });
    const onEnded = vi.fn();
    onScreenShareEnded({ getVideoTracks: () => [track] } as unknown as MediaStream, onEnded);
    expect(onEnded).toHaveBeenCalledTimes(1);
  });
});
