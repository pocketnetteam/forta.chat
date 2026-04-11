import { describe, it, expect, beforeEach } from "vitest";
import {
  normalizePocketnetImageUrl,
  setArchivedPeertubeServers,
  getArchivedPeertubeServers,
} from "./image-url";

beforeEach(() => {
  setArchivedPeertubeServers([]);
});

describe("normalizePocketnetImageUrl", () => {
  // ─── Empty / falsy inputs ────────────────────────────────────────

  it("returns empty string for null/undefined/empty", () => {
    expect(normalizePocketnetImageUrl(null)).toBe("");
    expect(normalizePocketnetImageUrl(undefined)).toBe("");
    expect(normalizePocketnetImageUrl("")).toBe("");
  });

  // ─── Relative → absolute ────────────────────────────────────────

  it("converts relative image id to bastyon.com/images/ URL", () => {
    expect(normalizePocketnetImageUrl("abc123def456")).toBe(
      "https://bastyon.com/images/abc123def456"
    );
  });

  it("does not prefix data: URLs", () => {
    const dataUrl = "data:image/png;base64,iVBOR";
    expect(normalizePocketnetImageUrl(dataUrl)).toBe(dataUrl);
  });

  it("does not prefix blob: URLs", () => {
    const blobUrl = "blob:https://example.com/1234";
    expect(normalizePocketnetImageUrl(blobUrl)).toBe(blobUrl);
  });

  it("does not double-prefix http URLs", () => {
    const url = "https://example.com/images/foo.jpg";
    expect(normalizePocketnetImageUrl(url)).toBe(url);
  });

  // ─── Host fixups ─────────────────────────────────────────────────

  it("replaces bastyon.com:8092 with pocketnet.app:8092", () => {
    expect(
      normalizePocketnetImageUrl("https://bastyon.com:8092/i/abc123")
    ).toBe("https://pocketnet.app:8092/i/abc123");
  });

  it("replaces test.pocketnet with pocketnet", () => {
    expect(
      normalizePocketnetImageUrl("https://test.pocketnet.app/image.jpg")
    ).toBe("https://pocketnet.app/image.jpg");
  });

  it("fixes double-scheme https://http://", () => {
    expect(
      normalizePocketnetImageUrl("https://http://example.com/img.jpg")
    ).toBe("http://example.com/img.jpg");
  });

  // ─── Archived peertube server rewriting ──────────────────────────

  it("rewrites archived peertube server host to archive CDN", () => {
    setArchivedPeertubeServers([
      "peertube700.pocketnet.app",
      "peertube100.pocketnet.app",
    ]);

    expect(
      normalizePocketnetImageUrl(
        "https://peertube700.pocketnet.app/images/9b243abf/9b243abf-original.jpg"
      )
    ).toBe(
      "https://peertube.archive.pocketnet.app/images/9b243abf/9b243abf-original.jpg"
    );
  });

  it("does not rewrite non-archived servers", () => {
    setArchivedPeertubeServers(["peertube700.pocketnet.app"]);

    const url = "https://peertube800.pocketnet.app/images/abc/abc-original.jpg";
    expect(normalizePocketnetImageUrl(url)).toBe(url);
  });

  it("rewrites only the matching server when multiple are archived", () => {
    setArchivedPeertubeServers([
      "peertube100.pocketnet.app",
      "peertube200.pocketnet.app",
    ]);

    expect(
      normalizePocketnetImageUrl(
        "https://peertube200.pocketnet.app/images/foo/foo-original.jpg"
      )
    ).toBe(
      "https://peertube.archive.pocketnet.app/images/foo/foo-original.jpg"
    );
  });

  // ─── Combined scenario ──────────────────────────────────────────

  it("handles relative id + archived server (no server match on relative)", () => {
    setArchivedPeertubeServers(["peertube700.pocketnet.app"]);
    const result = normalizePocketnetImageUrl("abc123");
    expect(result).toBe("https://bastyon.com/images/abc123");
  });

  it("applies all fixups in order", () => {
    setArchivedPeertubeServers(["peertube700.pocketnet.app"]);
    const url = "https://peertube700.pocketnet.app/images/abc-original.jpg";
    const result = normalizePocketnetImageUrl(url);
    expect(result).toBe(
      "https://peertube.archive.pocketnet.app/images/abc-original.jpg"
    );
  });
});

describe("setArchivedPeertubeServers / getArchivedPeertubeServers", () => {
  it("starts with empty list", () => {
    expect(getArchivedPeertubeServers()).toEqual([]);
  });

  it("stores and returns the list", () => {
    const servers = ["a.pocketnet.app", "b.pocketnet.app"];
    setArchivedPeertubeServers(servers);
    expect(getArchivedPeertubeServers()).toEqual(servers);
  });

  it("replaces previous list", () => {
    setArchivedPeertubeServers(["old.pocketnet.app"]);
    setArchivedPeertubeServers(["new.pocketnet.app"]);
    expect(getArchivedPeertubeServers()).toEqual(["new.pocketnet.app"]);
  });
});
