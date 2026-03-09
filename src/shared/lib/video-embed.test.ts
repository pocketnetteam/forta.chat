import { describe, it, expect } from "vitest";
import { parseVideoUrl } from "./video-embed";

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
      thumbUrl: `https://videos.example.com/lazy-static/previews/${uuid}.jpg`,
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
