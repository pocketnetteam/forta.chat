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
vi.mock("@/entities/auth", () => ({
  useAuthStore: vi.fn(() => ({ pcrypto: null })),
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

// --- Global fetch mock ---
const mockFetchResponse = {
  ok: true,
  blob: () => Promise.resolve(new Blob(["pdf-content"], { type: "application/pdf" })),
  arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
};
global.fetch = vi.fn(() => Promise.resolve(mockFetchResponse)) as Mock;

// Import after mocks
const { useFileDownload, revokeAllFileUrls } = await import("./use-file-download");

describe("useFileDownload", () => {
  beforeEach(() => {
    mockIsNative = false;
    mockIsElectron = false;
    vi.clearAllMocks();
    revokeAllFileUrls();
    // Reset window.electronAPI
    delete (window as any).electronAPI;
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
});
