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
});
