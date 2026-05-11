import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  saveShareData,
  consumeShareData,
  readShareUriAsBlob,
  type ExternalShareData,
} from "../share-target";

// Mocks for the platform + Filesystem bridge. Each test sets the platform
// flag explicitly via vi.doMock + dynamic re-import so we don't have to
// fight a frozen module graph.
const mockReadFile = vi.fn();
vi.mock("@capacitor/filesystem", () => ({
  Filesystem: { readFile: (...args: unknown[]) => mockReadFile(...args) },
}));

vi.mock("@/shared/lib/platform", () => ({
  isNative: true, // toggled per-test by importing fresh modules
}));

describe("share-target", () => {
  beforeEach(() => {
    localStorage.clear();
    mockReadFile.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("saveShareData / consumeShareData", () => {
    it("saves and retrieves text share data", () => {
      const data: ExternalShareData = { text: "Hello from browser" };
      saveShareData(data);
      const result = consumeShareData();
      expect(result).toEqual(data);
    });

    it("clears data after consuming", () => {
      saveShareData({ text: "once" });
      consumeShareData();
      expect(consumeShareData()).toBeNull();
    });

    it("returns null when no data saved", () => {
      expect(consumeShareData()).toBeNull();
    });

    it("saves file share data", () => {
      const data: ExternalShareData = {
        fileUri: "content://media/image.jpg",
        fileName: "image.jpg",
        mimeType: "image/jpeg",
      };
      saveShareData(data);
      expect(consumeShareData()).toEqual(data);
    });

    it("handles corrupted localStorage gracefully", () => {
      localStorage.setItem("bastyon-chat-share-data", "not-json{{{");
      expect(consumeShareData()).toBeNull();
    });
  });

  describe("readShareUriAsBlob", () => {
    it("routes content:// URIs through Capacitor Filesystem (not fetch) on native", async () => {
      // base64 for "hello"
      mockReadFile.mockResolvedValueOnce({ data: "aGVsbG8=" });

      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const blob = await readShareUriAsBlob(
        "content://com.android.providers.media/external/123",
        "image/jpeg",
      );

      expect(mockReadFile).toHaveBeenCalledWith({
        path: "content://com.android.providers.media/external/123",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(blob.type).toBe("image/jpeg");
      expect(await blob.text()).toBe("hello");
    });

    it("routes file:// URIs through Filesystem (legacy OEM share path)", async () => {
      mockReadFile.mockResolvedValueOnce({ data: "d29ybGQ=" }); // "world"
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const blob = await readShareUriAsBlob("file:///sdcard/photo.jpg", "image/jpeg");

      expect(mockReadFile).toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await blob.text()).toBe("world");
    });

    it("falls back to fetch for http(s) URIs (web PWA share)", async () => {
      const fetchBlob = new Blob(["fetched"], { type: "image/png" });
      const fetchSpy = vi.fn(async () => ({
        ok: true,
        status: 200,
        blob: async () => fetchBlob,
      }));
      vi.stubGlobal("fetch", fetchSpy);

      const blob = await readShareUriAsBlob("https://cdn.example.com/file.png", "image/png");

      expect(fetchSpy).toHaveBeenCalledWith("https://cdn.example.com/file.png");
      expect(mockReadFile).not.toHaveBeenCalled();
      expect(blob).toBe(fetchBlob);
    });

    it("surfaces fetch failures so the UI can show an error", async () => {
      const fetchSpy = vi.fn(async () => ({ ok: false, status: 404, blob: async () => new Blob() }));
      vi.stubGlobal("fetch", fetchSpy);

      await expect(
        readShareUriAsBlob("https://cdn.example.com/missing.png", "image/png"),
      ).rejects.toThrow(/Share fetch failed: 404/);
    });
  });
});
