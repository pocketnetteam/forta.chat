import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  saveShareData,
  consumeShareData,
  readShareUriAsBlob,
  type ExternalShareData,
} from "../share-target";

const mockReadFile = vi.fn();
vi.mock("@capacitor/filesystem", () => ({
  Filesystem: { readFile: (...args: unknown[]) => mockReadFile(...args) },
}));

vi.mock("@/shared/lib/platform", () => ({
  isNative: true,
}));

// Mirrors Capacitor's native-bridge convertFileSrc on Android.
vi.mock("@capacitor/core", () => ({
  Capacitor: {
    convertFileSrc: (p: string) =>
      p.startsWith("content://")
        ? "https://localhost" + p.replace("content:/", "/_capacitor_content_")
        : "https://localhost/_capacitor_file_" + p,
  },
}));

function okResponse(blob: Blob) {
  return { ok: true, status: 200, blob: async () => blob };
}

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
      expect(consumeShareData()).toEqual(data);
    });

    it("clears data after consuming", () => {
      saveShareData({ text: "once" });
      consumeShareData();
      expect(consumeShareData()).toBeNull();
    });

    it("returns null when no data saved", () => {
      expect(consumeShareData()).toBeNull();
    });

    it("saves multi-file share data", () => {
      const data: ExternalShareData = {
        files: [
          { uri: "/data/cache/a.png", name: "a.png", mimeType: "image/png" },
          { uri: "/data/cache/b.png", name: "b.png", mimeType: "image/png" },
        ],
      };
      saveShareData(data);
      expect(consumeShareData()).toEqual(data);
    });

    it("upgrades the legacy single-file shape persisted by older builds", () => {
      localStorage.setItem(
        "bastyon-chat-share-data",
        JSON.stringify({ text: "t", fileUri: "file:///c/x.jpg", fileName: "x.jpg", mimeType: "image/jpeg" }),
      );
      expect(consumeShareData()).toEqual({
        text: "t",
        files: [{ uri: "file:///c/x.jpg", name: "x.jpg", mimeType: "image/jpeg" }],
      });
    });

    it("handles corrupted localStorage gracefully", () => {
      localStorage.setItem("bastyon-chat-share-data", "not-json{{{");
      expect(consumeShareData()).toBeNull();
    });
  });

  describe("readShareUriAsBlob", () => {
    it("streams a bare sandbox path (what the capgo plugin returns) via the WebView local server", async () => {
      const fetchSpy = vi.fn(async () => okResponse(new Blob(["png"], { type: "image/png" })));
      vi.stubGlobal("fetch", fetchSpy);

      const blob = await readShareUriAsBlob(
        "/data/user/0/com.forta.chat/cache/shared_files/1_0_Screenshot 2026#1.png",
        "image/png",
      );

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://localhost/_capacitor_file_/data/user/0/com.forta.chat/cache/shared_files/1_0_Screenshot%202026%231.png",
      );
      expect(mockReadFile).not.toHaveBeenCalled();
      expect(blob.type).toBe("image/png");
      expect(await blob.text()).toBe("png");
    });

    it("does not double-encode an already percent-encoded file:// URI", async () => {
      const fetchSpy = vi.fn(async () => okResponse(new Blob(["x"], { type: "image/jpeg" })));
      vi.stubGlobal("fetch", fetchSpy);

      await readShareUriAsBlob("file:///data/cache/share-1-My%20Photo.jpg", "image/jpeg");

      expect(fetchSpy).toHaveBeenCalledWith("https://localhost/_capacitor_file_/data/cache/share-1-My%20Photo.jpg");
    });

    it("routes content:// URIs through the local-server content handler", async () => {
      const fetchSpy = vi.fn(async () => okResponse(new Blob(["c"], { type: "image/jpeg" })));
      vi.stubGlobal("fetch", fetchSpy);

      await readShareUriAsBlob("content://com.android.providers.media/external/123", "image/jpeg");

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://localhost/_capacitor_content_/com.android.providers.media/external/123",
      );
    });

    it("re-types the blob with the explicit mime (local server may answer octet-stream)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => okResponse(new Blob(["v"], { type: "application/octet-stream" }))));

      const blob = await readShareUriAsBlob("/data/cache/clip.mp4", "video/mp4");

      expect(blob.type).toBe("video/mp4");
    });

    it("falls back to Filesystem when the local server can't serve the file", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, blob: async () => new Blob() })));
      mockReadFile.mockResolvedValueOnce({ data: "aGVsbG8=" }); // "hello"

      const blob = await readShareUriAsBlob("content://media/external/123", "image/jpeg");

      expect(mockReadFile).toHaveBeenCalledWith({ path: "content://media/external/123" });
      expect(blob.type).toBe("image/jpeg");
      expect(await blob.text()).toBe("hello");
    });

    // Regression: the fallback URI after a failed cache copy is a bare path.
    // It used to be handed to a plain fetch("/data/…"), which 404'd against
    // the app origin and failed the share.
    it("never fetches a bare path against the app origin; falls back to Filesystem", async () => {
      const fetchSpy = vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      });
      vi.stubGlobal("fetch", fetchSpy);
      mockReadFile.mockResolvedValueOnce({ data: "d29ybGQ=" }); // "world"

      const blob = await readShareUriAsBlob("/data/user/0/com.forta.chat/cache/shared_files/v.mp4", "video/mp4");

      expect(fetchSpy).not.toHaveBeenCalledWith("/data/user/0/com.forta.chat/cache/shared_files/v.mp4");
      expect(mockReadFile).toHaveBeenCalledWith({ path: "/data/user/0/com.forta.chat/cache/shared_files/v.mp4" });
      expect(await blob.text()).toBe("world");
    });

    it("fetches http(s) URIs directly (web PWA share)", async () => {
      const fetchBlob = new Blob(["fetched"], { type: "image/png" });
      const fetchSpy = vi.fn(async () => okResponse(fetchBlob));
      vi.stubGlobal("fetch", fetchSpy);

      const blob = await readShareUriAsBlob("https://cdn.example.com/file.png", "image/png");

      expect(fetchSpy).toHaveBeenCalledWith("https://cdn.example.com/file.png");
      expect(mockReadFile).not.toHaveBeenCalled();
      expect(blob).toBe(fetchBlob);
    });

    it("surfaces http fetch failures so the UI can show an error", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, blob: async () => new Blob() })));

      await expect(readShareUriAsBlob("https://cdn.example.com/missing.png", "image/png")).rejects.toThrow(
        /Share fetch failed: 404/,
      );
    });
  });
});
