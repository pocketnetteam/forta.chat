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
  it("returns empty string for null/undefined/empty", () => {
    expect(normalizePocketnetImageUrl(null)).toBe("");
    expect(normalizePocketnetImageUrl(undefined)).toBe("");
    expect(normalizePocketnetImageUrl("")).toBe("");
  });

  it("converts relative image id to bastyon.com/images/ URL", () => {
    expect(normalizePocketnetImageUrl("abc123def456")).toBe(
      "https://bastyon.com/images/abc123def456"
    );
  });

  it("does not prefix data: or blob: URLs", () => {
    expect(normalizePocketnetImageUrl("data:image/png;base64,xx")).toBe("data:image/png;base64,xx");
    expect(normalizePocketnetImageUrl("blob:https://example.com/1")).toBe("blob:https://example.com/1");
  });

  it("replaces bastyon.com:8092 with pocketnet.app:8092", () => {
    expect(normalizePocketnetImageUrl("https://bastyon.com:8092/i/abc")).toBe(
      "https://pocketnet.app:8092/i/abc"
    );
  });

  it("replaces test.pocketnet with pocketnet", () => {
    expect(normalizePocketnetImageUrl("https://test.pocketnet.app/x")).toBe(
      "https://pocketnet.app/x"
    );
  });

  it("fixes double-scheme https://http://", () => {
    expect(normalizePocketnetImageUrl("https://http://example.com/img.jpg")).toBe(
      "http://example.com/img.jpg"
    );
  });

  it("rewrites archived peertube server host to archive CDN", () => {
    setArchivedPeertubeServers(["peertube700.pocketnet.app"]);
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
    const url = "https://peertube800.pocketnet.app/images/a/a-original.jpg";
    expect(normalizePocketnetImageUrl(url)).toBe(url);
  });
});

describe("setArchivedPeertubeServers / getArchivedPeertubeServers", () => {
  it("starts with empty list", () => {
    expect(getArchivedPeertubeServers()).toEqual([]);
  });

  it("stores and returns the list", () => {
    setArchivedPeertubeServers(["a.pocketnet.app"]);
    expect(getArchivedPeertubeServers()).toEqual(["a.pocketnet.app"]);
  });
});
