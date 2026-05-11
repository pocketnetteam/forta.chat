import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { effectScope } from "vue";

// --- Platform mock: default = web ---
let mockIsNative = false;
let mockIsElectron = false;

vi.mock("@/shared/lib/platform", () => ({
  get isNative() { return mockIsNative; },
  get isElectron() { return mockIsElectron; },
}));

// --- Auth store mock ---
// authStore.pcrypto is mutated per-test via `setMockPcrypto` for the
// crypto-wait integration tests. Tests that don't touch it default to null.
let mockPcrypto: { rooms: Record<string, unknown> } | null = null;
function setMockPcrypto(value: typeof mockPcrypto) {
  mockPcrypto = value;
}
vi.mock("@/entities/auth", () => ({
  useAuthStore: vi.fn(() => ({ get pcrypto() { return mockPcrypto; } })),
}));

// --- Capacitor Filesystem mock ---
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockWriteFile: Mock = vi.fn(() => Promise.resolve({ uri: "file:///cache/test.pdf" }));
vi.mock("@capacitor/filesystem", () => ({
  Filesystem: { get writeFile() { return mockWriteFile; } },
  Directory: { Cache: "CACHE" },
}));

// --- FileOpener mock ---
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFileOpenerOpen: Mock = vi.fn(() => Promise.resolve());
vi.mock("@capacitor-community/file-opener", () => ({
  FileOpener: { get open() { return mockFileOpenerOpen; } },
}));

// --- Share mock ---
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockShare: Mock = vi.fn(() => Promise.resolve());
vi.mock("@capacitor/share", () => ({
  Share: { get share() { return mockShare; } },
}));

// --- Matrix crypto mock ---
vi.mock("@/shared/lib/matrix/functions", () => ({
  hexEncode: vi.fn((s: string) => s),
}));

// --- Bug report & i18n mocks (called on download errors) ---
vi.mock("@/features/bug-report", () => ({
  useBugReport: vi.fn(() => ({ open: vi.fn() })),
}));
vi.mock("@/shared/lib/i18n", () => ({
  tRaw: (k: string) => k,
}));

// --- Toast mock (called when typed transient errors surface) ---
const mockToast: Mock = vi.fn();
vi.mock("@/shared/lib/use-toast", () => ({
  useToast: () => ({
    toast: mockToast,
    close: vi.fn(),
    message: { value: "" },
    type: { value: "info" },
    show: { value: false },
  }),
}));

// --- Global fetch mock ---
const mockFetchResponse = {
  ok: true,
  blob: () => Promise.resolve(new Blob(["pdf-content"], { type: "application/pdf" })),
  arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
};
global.fetch = vi.fn(() => Promise.resolve(mockFetchResponse)) as Mock;

// Import after mocks
const {
  useFileDownload,
  revokeAllFileUrls,
  appendCacheBust,
  wrapTransientError,
} = await import("./use-file-download");
const { MediaUnavailableError, NetworkBlockedError } = await import(
  "@/shared/lib/network/typed-network-errors"
);
// Pull static type aliases for cast assertions — the dynamic imports above
// only give us values, so without these the test file fails vue-tsc with
// "X refers to a value, but is being used as a type here".
import type {
  MediaUnavailableError as MediaUnavailableErrorT,
} from "@/shared/lib/network/typed-network-errors";

describe("useFileDownload", () => {
  beforeEach(() => {
    mockIsNative = false;
    mockIsElectron = false;
    vi.clearAllMocks();
    revokeAllFileUrls();
    // Reset window.electronAPI
    delete (window as any).electronAPI;
    // Reset crypto stub so tests that do not touch encryption see no
    // pcrypto (matches the original mock default).
    setMockPcrypto(null);
  });

  describe("saveFile — web platform", () => {
    it("creates <a> element with download attribute and clicks it", async () => {
      const scope = effectScope();
      await scope.run(async () => {
        const { saveFile } = useFileDownload();
        const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click");

        await saveFile("blob:http://localhost/abc", "report.pdf");

        expect(clickSpy).toHaveBeenCalled();
        clickSpy.mockRestore();
      });
      scope.stop();
    });
  });

  describe("saveFile — native platform (Android/iOS)", () => {
    beforeEach(() => {
      mockIsNative = true;
    });

    it("writes file to cache and opens with FileOpener", async () => {
      const scope = effectScope();
      await scope.run(async () => {
        const { saveFile } = useFileDownload();

        await saveFile("blob:http://localhost/abc", "report.pdf", "application/pdf");

        expect(mockWriteFile).toHaveBeenCalledWith({
          path: "report.pdf",
          data: expect.any(String),
          directory: "CACHE",
        });

        expect(mockFileOpenerOpen).toHaveBeenCalledWith({
          filePath: "file:///cache/test.pdf",
          contentType: "application/pdf",
          openWithDefault: true,
        });
      });
      scope.stop();
    });

    it("falls back to Share when FileOpener fails", async () => {
      mockFileOpenerOpen.mockRejectedValueOnce(new Error("No app found"));

      const scope = effectScope();
      await scope.run(async () => {
        const { saveFile } = useFileDownload();

        await saveFile("blob:http://localhost/abc", "report.pdf", "application/pdf");

        expect(mockShare).toHaveBeenCalledWith({
          title: "report.pdf",
          url: "file:///cache/test.pdf",
          dialogTitle: "report.pdf",
        });
      });
      scope.stop();
    });

    it("guesses MIME type from extension when not provided", async () => {
      const scope = effectScope();
      await scope.run(async () => {
        const { saveFile } = useFileDownload();

        await saveFile("blob:http://localhost/abc", "document.xlsx");

        expect(mockFileOpenerOpen).toHaveBeenCalledWith(
          expect.objectContaining({
            contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          }),
        );
      });
      scope.stop();
    });

    it("defaults to application/octet-stream for unknown extensions", async () => {
      const scope = effectScope();
      await scope.run(async () => {
        const { saveFile } = useFileDownload();

        await saveFile("blob:http://localhost/abc", "data.xyz");

        expect(mockFileOpenerOpen).toHaveBeenCalledWith(
          expect.objectContaining({
            contentType: "application/octet-stream",
          }),
        );
      });
      scope.stop();
    });
  });

  describe("saveFile — Electron platform", () => {
    beforeEach(() => {
      mockIsElectron = true;
    });

    it("calls electronAPI.saveFile when available", async () => {
      const mockElectronSave = vi.fn(() => Promise.resolve("/downloads/report.pdf"));
      (window as any).electronAPI = { isElectron: true, saveFile: mockElectronSave };

      const scope = effectScope();
      await scope.run(async () => {
        const { saveFile } = useFileDownload();

        await saveFile("blob:http://localhost/abc", "report.pdf");

        expect(mockElectronSave).toHaveBeenCalledWith("report.pdf", expect.any(ArrayBuffer));
      });
      scope.stop();
    });

    it("falls back to <a download> when electronAPI not available", async () => {
      const scope = effectScope();
      await scope.run(async () => {
        const { saveFile } = useFileDownload();
        const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click");

        await saveFile("blob:http://localhost/abc", "report.pdf");

        expect(clickSpy).toHaveBeenCalled();
        clickSpy.mockRestore();
      });
      scope.stop();
    });
  });

  describe("formatSize", () => {
    it("formats bytes correctly", () => {
      const scope = effectScope();
      scope.run(() => {
        const { formatSize } = useFileDownload();
        expect(formatSize(0)).toBe("0 B");
        expect(formatSize(1024)).toBe("1.0 KB");
        expect(formatSize(1536)).toBe("1.5 KB");
        expect(formatSize(1048576)).toBe("1.0 MB");
        expect(formatSize(1073741824)).toBe("1.0 GB");
      });
      scope.stop();
    });
  });

  describe("download — network resilience", () => {
    it("passes an AbortSignal to fetch so hanging requests can be cancelled (MIUI/Tor scenario)", async () => {
      // Immediately resolve so the test runs fast — we're only verifying that
      // fetch was called with an AbortSignal (proving the abort mechanism is
      // wired up), not the full retry timing behavior.
      (global.fetch as Mock).mockResolvedValue({
        ok: true,
        status: 200,
        blob: () => Promise.resolve(new Blob([new Uint8Array([1, 2, 3])])),
      });

      const scope = effectScope();
      await scope.run(async () => {
        const { download } = useFileDownload();
        const message = {
          id: "$evt1",
          _key: "client_abort",
          roomId: "!room:server",
          senderId: "@u:server",
          content: "file.pdf",
          timestamp: Date.now(),
          status: "sent",
          type: "file",
          fileInfo: {
            name: "file.pdf",
            type: "application/pdf",
            size: 1024,
            url: "https://example.com/file.pdf",
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;

        await download(message);

        // The fetch MUST have been called with an AbortSignal so a hung
        // request can be cancelled by the FETCH_TIMEOUT timer.
        expect((global.fetch as Mock).mock.calls.length).toBeGreaterThanOrEqual(1);
        const [, init] = (global.fetch as Mock).mock.calls[0];
        expect(init).toBeDefined();
        expect(init.signal).toBeInstanceOf(AbortSignal);
      });
      scope.stop();
    });

    it("appends a cache-bust query parameter to retry URLs but not the first attempt", () => {
      // First attempt: pristine URL — server-side caches matter only after a
      // confirmed miss, so don't pollute attempt 0.
      expect(appendCacheBust("https://example.com/file.pdf", 0)).toBe(
        "https://example.com/file.pdf",
      );

      // Retries: cache-bust must appear so Service Workers / CDN edges
      // re-resolve the response instead of replaying the original failure.
      const second = appendCacheBust("https://example.com/file.pdf", 1);
      expect(second).toMatch(/^https:\/\/example\.com\/file\.pdf\?cb=/);

      // Existing query string: must use & separator, not a second ?
      const withQuery = appendCacheBust("https://example.com/file.pdf?token=abc", 2);
      expect(withQuery).toMatch(/^https:\/\/example\.com\/file\.pdf\?token=abc&cb=/);
    });

    it("retry attempts produce distinct cache-bust values", () => {
      const a = appendCacheBust("https://example.com/file.pdf", 1);
      const b = appendCacheBust("https://example.com/file.pdf", 2);
      const c = appendCacheBust("https://example.com/file.pdf", 3);
      expect(a).not.toBe(b);
      expect(b).not.toBe(c);
      expect(a).not.toBe(c);
    });

    it("wrapTransientError maps Failed-to-fetch into NetworkBlockedError", () => {
      const wrapped = wrapTransientError(
        new TypeError("Failed to fetch"),
        "https://example.com/file.pdf",
      );
      expect(wrapped).toBeInstanceOf(NetworkBlockedError);
    });

    it("wrapTransientError maps generic errors into MediaUnavailableError with the URL", () => {
      const wrapped = wrapTransientError(
        new Error("Download failed: 503"),
        "https://example.com/file.pdf",
      );
      expect(wrapped).toBeInstanceOf(MediaUnavailableError);
      expect((wrapped as MediaUnavailableErrorT).mxcUrl).toBe(
        "https://example.com/file.pdf",
      );
    });

    it("retry adds a cache-bust parameter on the second fetch attempt", async () => {
      // 5xx forces the retry path; second attempt resolves OK so the test
      // doesn't have to wait through the full retry budget.
      (global.fetch as Mock)
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          blob: () => Promise.resolve(new Blob()),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          blob: () => Promise.resolve(new Blob([new Uint8Array([1, 2, 3])])),
        });

      const scope = effectScope();
      await scope.run(async () => {
        const { download } = useFileDownload();
        const message = {
          id: "$evt_cb",
          _key: "client_cb",
          roomId: "!room:server",
          senderId: "@u:server",
          content: "file.pdf",
          timestamp: Date.now(),
          status: "sent",
          type: "file",
          fileInfo: {
            name: "file.pdf",
            type: "application/pdf",
            size: 1024,
            url: "https://example.com/file.pdf",
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;

        await download(message);

        const calls = (global.fetch as Mock).mock.calls;
        expect(calls.length).toBeGreaterThanOrEqual(2);
        // First attempt: pristine URL.
        expect(calls[0][0]).toBe("https://example.com/file.pdf");
        // Second attempt: cache-busted URL.
        expect(calls[1][0]).toMatch(/^https:\/\/example\.com\/file\.pdf\?cb=/);
      });
      scope.stop();
    }, 15_000);

    it("surfaces a localised toast when retries exhaust on Failed-to-fetch (region block)", async () => {
      (global.fetch as Mock).mockRejectedValue(new TypeError("Failed to fetch"));

      const scope = effectScope();
      await scope.run(async () => {
        const { download } = useFileDownload();
        const message = {
          id: "$evt_toast_blocked",
          _key: "client_toast_blocked",
          roomId: "!room:server",
          senderId: "@u:server",
          content: "file.pdf",
          timestamp: Date.now(),
          status: "sent",
          type: "file",
          fileInfo: {
            name: "file.pdf",
            type: "application/pdf",
            size: 1024,
            url: "https://example.com/blocked.pdf",
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;

        await download(message);

        expect(mockToast).toHaveBeenCalledWith(
          "errors.networkBlocked",
          "error",
          expect.any(Number),
        );
      });
      scope.stop();
    }, 30_000);

    it("after retry exhaustion, exposes errorKind='network' to the UI", async () => {
      (global.fetch as Mock).mockRejectedValue(new TypeError("Failed to fetch"));

      const scope = effectScope();
      await scope.run(async () => {
        const { download, getState } = useFileDownload();
        const message = {
          id: "$evt_blocked",
          _key: "client_blocked",
          roomId: "!room:server",
          senderId: "@u:server",
          content: "file.pdf",
          timestamp: Date.now(),
          status: "sent",
          type: "file",
          fileInfo: {
            name: "file.pdf",
            type: "application/pdf",
            size: 1024,
            url: "https://example.com/blocked.pdf",
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;

        await download(message);
        const state = getState("client_blocked");
        expect(state.errorKind).toBe("network");
      });
      scope.stop();
    }, 30_000);

    it("waits for pcrypto.rooms[roomId] to populate before decrypting (issue #616)", async () => {
      // Encrypted file: download path goes through waitForRoomCrypto.
      // Initially pcrypto is null (race against Matrix sync); then it
      // populates after a short delay — the download must succeed.
      const decryptedBlob = new File([new Uint8Array([9, 9, 9])], "decrypted.bin");
      const decryptKey = vi.fn(() => Promise.resolve("k"));
      const decryptFile = vi.fn(() => Promise.resolve(decryptedBlob));
      const fakeRoom = { decryptKey, decryptFile };

      (global.fetch as Mock).mockResolvedValue({
        ok: true,
        status: 200,
        blob: () => Promise.resolve(new Blob([new Uint8Array([1, 2, 3])])),
      });

      // Populate pcrypto on the next macrotask — this is what Matrix sync
      // does in production once the room state has caught up.
      setMockPcrypto(null);
      setTimeout(() => {
        setMockPcrypto({ rooms: { "!room:server": fakeRoom } });
      }, 150);

      const scope = effectScope();
      await scope.run(async () => {
        const { download } = useFileDownload();
        const message = {
          id: "$evt_wait",
          _key: "client_wait",
          roomId: "!room:server",
          senderId: "@u:server",
          content: "secret.bin",
          timestamp: Date.now(),
          status: "sent",
          type: "file",
          fileInfo: {
            name: "secret.bin",
            type: "application/octet-stream",
            size: 3,
            url: "https://example.com/secret.bin",
            secrets: { keys: "k", block: 1, v: 1 },
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;

        const url = await download(message);

        expect(url).toBeTruthy();
        expect(decryptKey).toHaveBeenCalled();
        expect(decryptFile).toHaveBeenCalled();
      });
      scope.stop();
    }, 15_000);

    it("fast-fails on CryptoNotReadyError instead of burning the full retry budget", async () => {
      // pcrypto never populates — waitForRoomCrypto will time out at 5s on
      // the first attempt, then the outer loop must NOT re-enter (otherwise
      // the user waits ~40s for what will never resolve).
      setMockPcrypto(null);
      (global.fetch as Mock).mockResolvedValue({
        ok: true,
        status: 200,
        blob: () => Promise.resolve(new Blob([new Uint8Array([1, 2, 3])])),
      });

      const scope = effectScope();
      await scope.run(async () => {
        const { download, getState } = useFileDownload();
        const message = {
          id: "$evt_no_crypto",
          _key: "client_no_crypto",
          roomId: "!room:server",
          senderId: "@u:server",
          content: "secret.bin",
          timestamp: Date.now(),
          status: "sent",
          type: "file",
          fileInfo: {
            name: "secret.bin",
            type: "application/octet-stream",
            size: 3,
            url: "https://example.com/secret.bin",
            secrets: { keys: "k", block: 1, v: 1 },
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;

        await download(message);

        // Exactly one fetch attempt — no retry burn after CryptoNotReadyError.
        expect((global.fetch as Mock).mock.calls.length).toBe(1);
        // UI sees the crypto-not-ready toast and a network-class error.
        expect(getState("client_no_crypto").errorKind).toBe("network");
        expect(mockToast).toHaveBeenCalledWith(
          "errors.cryptoNotReady",
          "error",
          expect.any(Number),
        );
      });
      scope.stop();
    }, 30_000);

    it("does not retry on 404 (fast-fail)", async () => {
      (global.fetch as Mock).mockResolvedValue({
        ok: false,
        status: 404,
        blob: () => Promise.resolve(new Blob()),
      });

      const scope = effectScope();
      await scope.run(async () => {
        const { download } = useFileDownload();
        const message = {
          id: "$evt2",
          _key: "client_2",
          roomId: "!room:server",
          senderId: "@u:server",
          content: "file.pdf",
          timestamp: Date.now(),
          status: "sent",
          type: "file",
          fileInfo: {
            name: "file.pdf",
            type: "application/pdf",
            size: 1024,
            url: "https://example.com/missing.pdf",
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;

        await download(message);

        // 404 → one attempt, NOT retried 3+ times
        expect((global.fetch as Mock).mock.calls.length).toBe(1);
      });
      scope.stop();
    });
  });

  // -------------------------------------------------------------------------
  // forceRefetch — Session 44
  // Voice-message retry button needs to bypass the per-message media cache
  // so a stuck encrypted blob can be re-fetched + re-decrypted with a fresh
  // objectUrl (issues #695, #671).
  // -------------------------------------------------------------------------
  describe("download — forceRefetch (Session 44)", () => {
    const baseMessage = {
      id: "$evt_force",
      _key: "client_force",
      roomId: "!room:server",
      senderId: "@u:server",
      content: "voice.ogg",
      timestamp: Date.now(),
      status: "sent",
      type: "audio",
      fileInfo: {
        name: "voice.ogg",
        type: "audio/ogg",
        size: 512,
        url: "https://example.com/voice.ogg",
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    beforeEach(() => {
      (global.fetch as Mock).mockResolvedValue({
        ok: true,
        status: 200,
        blob: () => Promise.resolve(new Blob([new Uint8Array([1, 2, 3])])),
      });
    });

    it("returns the cached objectUrl on a second call without forceRefetch", async () => {
      const scope = effectScope();
      await scope.run(async () => {
        const { download } = useFileDownload();

        const first = await download(baseMessage);
        const callsAfterFirst = (global.fetch as Mock).mock.calls.length;

        const second = await download(baseMessage);

        expect(second).toBe(first);
        // Cache hit — no extra fetch.
        expect((global.fetch as Mock).mock.calls.length).toBe(callsAfterFirst);
      });
      scope.stop();
    });

    it("bypasses the cache and re-fetches when forceRefetch=true", async () => {
      const scope = effectScope();
      await scope.run(async () => {
        const { download } = useFileDownload();

        await download(baseMessage);
        const callsAfterFirst = (global.fetch as Mock).mock.calls.length;

        await download(baseMessage, undefined, { forceRefetch: true });

        expect((global.fetch as Mock).mock.calls.length).toBeGreaterThan(callsAfterFirst);
      });
      scope.stop();
    });

    it("revokes the prior objectUrl and produces a fresh one when forceRefetch=true", async () => {
      const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
      try {
        const scope = effectScope();
        await scope.run(async () => {
          const { download } = useFileDownload();

          const first = await download(baseMessage);
          revokeSpy.mockClear();

          const second = await download(baseMessage, undefined, { forceRefetch: true });

          expect(revokeSpy).toHaveBeenCalledWith(first);
          expect(second).not.toBe(first);
        });
        scope.stop();
      } finally {
        revokeSpy.mockRestore();
      }
    });
  });
});
