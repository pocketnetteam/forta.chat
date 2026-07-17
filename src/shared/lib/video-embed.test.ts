import { describe, it, expect, vi, afterEach } from "vitest";
import { parseVideoUrl, fetchPeerTubeFileUrl } from "./video-embed";

describe("parseVideoUrl", () => {
  // ─── YouTube ────────────────────────────────────────────────────

  it("parses youtube.com/watch?v= URL", () => {
    const result = parseVideoUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(result).toEqual({
      type: "youtube",
      id: "dQw4w9WgXcQ",
      embedUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ",
      thumbUrl: "https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    });
  });

  it("parses youtu.be short URL", () => {
    const result = parseVideoUrl("https://youtu.be/dQw4w9WgXcQ");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("youtube");
    expect(result!.id).toBe("dQw4w9WgXcQ");
  });

  it("parses youtube.com/embed/ URL", () => {
    const result = parseVideoUrl("https://www.youtube.com/embed/dQw4w9WgXcQ");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("dQw4w9WgXcQ");
  });

  it("parses youtube.com/shorts/ URL", () => {
    const result = parseVideoUrl("https://www.youtube.com/shorts/AbCdEfGhIjK");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("youtube");
    expect(result!.id).toBe("AbCdEfGhIjK");
  });

  it("handles YouTube URL with extra params", () => {
    const result = parseVideoUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=120");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("dQw4w9WgXcQ");
  });

  // ─── Vimeo ──────────────────────────────────────────────────────

  it("parses vimeo.com URL", () => {
    const result = parseVideoUrl("https://vimeo.com/123456789");
    expect(result).toEqual({
      type: "vimeo",
      id: "123456789",
      embedUrl: "https://player.vimeo.com/video/123456789",
      thumbUrl: "",
    });
  });

  // ─── PeerTube ───────────────────────────────────────────────────

  it("parses peertube:// protocol URL", () => {
    const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const result = parseVideoUrl(`peertube://videos.example.com/${uuid}`);
    expect(result).toEqual({
      type: "peertube",
      id: uuid,
      embedUrl: `https://videos.example.com/videos/embed/${uuid}`,
      // Thumb is resolved lazily via the API (the preview UUID differs from
      // the video UUID) — parse returns the API URL instead.
      thumbUrl: "",
      apiUrl: `https://videos.example.com/api/v1/videos/${uuid}`,
    });
  });

  // ─── Invalid / Edge cases ───────────────────────────────────────

  it("returns null for empty string", () => {
    expect(parseVideoUrl("")).toBeNull();
  });

  it("returns null for non-video URL", () => {
    expect(parseVideoUrl("https://example.com/page")).toBeNull();
  });

  it("returns null for plain text", () => {
    expect(parseVideoUrl("just some text")).toBeNull();
  });

  it("returns null for YouTube-like URL with wrong ID length", () => {
    expect(parseVideoUrl("https://youtube.com/watch?v=short")).toBeNull();
  });
});

describe("fetchPeerTubeFileUrl (WEE-82)", () => {
  const API_URL = "https://videos.example.com/api/v1/videos/abc";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(payload: unknown, ok = true) {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok,
          json: () => Promise.resolve(payload),
        }),
      ),
    );
  }

  it("picks the web-video file closest to 720p", async () => {
    stubFetch({
      files: [
        { fileUrl: "https://cdn/240.mp4", resolution: { id: 240 } },
        { fileUrl: "https://cdn/720.mp4", resolution: { id: 720 } },
        { fileUrl: "https://cdn/1080.mp4", resolution: { id: 1080 } },
      ],
    });
    await expect(fetchPeerTubeFileUrl(API_URL)).resolves.toBe("https://cdn/720.mp4");
  });

  it("falls back to streamingPlaylists files when web videos are absent", async () => {
    stubFetch({
      files: [],
      streamingPlaylists: [
        {
          files: [{ fileUrl: "https://cdn/hls-480.mp4", resolution: { id: 480 } }],
        },
      ],
    });
    await expect(fetchPeerTubeFileUrl(API_URL)).resolves.toBe("https://cdn/hls-480.mp4");
  });

  it("returns null when no files exist (caller falls back to iframe)", async () => {
    stubFetch({ files: [], streamingPlaylists: [] });
    await expect(fetchPeerTubeFileUrl(API_URL)).resolves.toBeNull();
  });

  it("returns null on HTTP error", async () => {
    stubFetch({}, false);
    await expect(fetchPeerTubeFileUrl(API_URL)).resolves.toBeNull();
  });

  it("returns null on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    await expect(fetchPeerTubeFileUrl(API_URL)).resolves.toBeNull();
  });

  it("ignores entries without fileUrl", async () => {
    stubFetch({
      files: [
        { resolution: { id: 720 } },
        { fileUrl: "https://cdn/360.mp4", resolution: { id: 360 } },
      ],
    });
    await expect(fetchPeerTubeFileUrl(API_URL)).resolves.toBe("https://cdn/360.mp4");
  });
});
