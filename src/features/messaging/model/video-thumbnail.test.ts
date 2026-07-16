import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { formatVideoDuration, extractVideoFrameThumbnail } from "./video-thumbnail";

/**
 * UX regression for WEE-32 (forta-bugs#788, #789).
 *
 * Video bubbles in chat must display a Telegram-style duration badge and a
 * generated first-frame poster. These helpers underpin both: `formatVideoDuration`
 * formats the duration shown in the bottom-right badge; `extractVideoFrameThumbnail`
 * produces the poster shown before the user taps play.
 */

describe("formatVideoDuration — Telegram-style M:SS / H:MM:SS", () => {
  it("formats sub-minute durations as M:SS with zero-padded seconds", () => {
    expect(formatVideoDuration(0)).toBe("0:00");
    expect(formatVideoDuration(5)).toBe("0:05");
    expect(formatVideoDuration(30)).toBe("0:30");
    expect(formatVideoDuration(59)).toBe("0:59");
  });

  it("formats minute-range durations as M:SS without hour padding", () => {
    expect(formatVideoDuration(60)).toBe("1:00");
    expect(formatVideoDuration(65)).toBe("1:05");
    expect(formatVideoDuration(605)).toBe("10:05");
    expect(formatVideoDuration(3599)).toBe("59:59");
  });

  it("switches to H:MM:SS once the duration crosses one hour", () => {
    expect(formatVideoDuration(3600)).toBe("1:00:00");
    expect(formatVideoDuration(3725)).toBe("1:02:05");
    expect(formatVideoDuration(36005)).toBe("10:00:05");
  });

  it("floors fractional seconds (does not round up)", () => {
    expect(formatVideoDuration(59.9)).toBe("0:59");
    expect(formatVideoDuration(0.99)).toBe("0:00");
  });

  it("returns empty string for invalid input so callers can hide the badge", () => {
    expect(formatVideoDuration(undefined)).toBe("");
    expect(formatVideoDuration(null)).toBe("");
    expect(formatVideoDuration(Number.NaN)).toBe("");
    expect(formatVideoDuration(Number.POSITIVE_INFINITY)).toBe("");
    expect(formatVideoDuration(-5)).toBe("");
  });
});

describe("extractVideoFrameThumbnail — first-frame poster generation", () => {
  // happy-dom does not decode video frames or back canvas.toBlob with a real
  // encoder, so we stub the DOM seams the helper uses. These tests verify the
  // orchestration contract (seek, draw, encode, revoke on failure) rather than
  // the image data itself.

  let createdVideos: FakeVideo[];
  let createdCanvases: FakeCanvas[];
  let originalCreateElement: typeof document.createElement;
  let originalCreateObjectURL: typeof URL.createObjectURL;

  type Listener = () => void;

  class FakeVideo {
    src = "";
    preload = "";
    muted = false;
    crossOrigin: string | null = null;
    playsInline = false;
    currentTime = 0;
    videoWidth = 320;
    videoHeight = 240;
    duration = 12.5;
    listeners: Record<string, Listener[]> = {};
    addEventListener(name: string, fn: Listener) {
      (this.listeners[name] ||= []).push(fn);
    }
    removeEventListener(name: string, fn: Listener) {
      this.listeners[name] = (this.listeners[name] ?? []).filter((l) => l !== fn);
    }
    removeAttribute() {/* noop */}
    load() {/* noop */}
    fire(name: string) {
      for (const l of this.listeners[name] ?? []) l();
    }
  }

  class FakeCanvas {
    width = 0;
    height = 0;
    drawn = false;
    toBlobArgs: { type?: string; quality?: number } = {};
    getContext() {
      return {
        drawImage: () => { this.drawn = true; },
      };
    }
    toBlob(cb: (b: Blob | null) => void, type?: string, quality?: number) {
      this.toBlobArgs = { type, quality };
      // Resolve asynchronously so the helper's promise chain mirrors real browsers.
      queueMicrotask(() => cb(new Blob(["fake"], { type: type ?? "image/jpeg" })));
    }
  }

  beforeEach(() => {
    createdVideos = [];
    createdCanvases = [];
    originalCreateElement = document.createElement.bind(document);
    originalCreateObjectURL = URL.createObjectURL.bind(URL);

    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "video") {
        const v = new FakeVideo();
        createdVideos.push(v);
        return v as unknown as HTMLVideoElement;
      }
      if (tag === "canvas") {
        const c = new FakeCanvas();
        createdCanvases.push(c);
        return c as unknown as HTMLCanvasElement;
      }
      return originalCreateElement(tag);
    });
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:fake/thumb");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    void originalCreateObjectURL;
  });

  it("seeks past the first keyframe, draws to canvas, and resolves with a blob URL", async () => {
    const promise = extractVideoFrameThumbnail("blob:fake/video");
    // Flush microtask so the helper has attached listeners and set src.
    await Promise.resolve();
    const video = createdVideos[0];
    expect(video).toBeDefined();
    video.fire("loadeddata");
    // Helper should request a seek shortly after loadeddata.
    expect(video.currentTime).toBeGreaterThan(0);
    video.fire("seeked");
    const url = await promise;
    expect(url).toBe("blob:fake/thumb");
    const canvas = createdCanvases[0];
    expect(canvas).toBeDefined();
    expect(canvas.drawn).toBe(true);
    expect(canvas.toBlobArgs.type).toBe("image/jpeg");
  });

  it("resolves to null and does not draw when the video errors before metadata loads", async () => {
    const promise = extractVideoFrameThumbnail("blob:fake/broken");
    await Promise.resolve();
    const video = createdVideos[0];
    video.fire("error");
    const url = await promise;
    expect(url).toBeNull();
    expect(createdCanvases.length === 0 || createdCanvases[0].drawn === false).toBe(true);
  });

  it("clamps the seek target to the video's duration to avoid seeking past the end", async () => {
    const promise = extractVideoFrameThumbnail("blob:fake/short", { seekSeconds: 30 });
    await Promise.resolve();
    const video = createdVideos[0];
    video.duration = 1.0;
    video.fire("loadeddata");
    // currentTime must stay inside the playable window.
    expect(video.currentTime).toBeLessThan(video.duration);
    video.fire("seeked");
    await promise;
  });

  it("resolves to null when the video reports zero dimensions (decoder failed)", async () => {
    const promise = extractVideoFrameThumbnail("blob:fake/empty");
    await Promise.resolve();
    const video = createdVideos[0];
    video.videoWidth = 0;
    video.videoHeight = 0;
    video.fire("loadeddata");
    video.fire("seeked");
    const url = await promise;
    expect(url).toBeNull();
  });
});
