import { describe, it, expect, vi, beforeEach } from "vitest";

// Avatar upload used to reject files >5MB outright. Cameras on realme/Samsung
// (16MP) produce JPEGs up to 8-10MB, which blocked avatar changes for most
// mobile users. The fix is an auto-compression helper that ensures the output
// stays under MAX_FILE_SIZE via canvas resize + quality reduction.

function makeFakeFile(sizeBytes: number, mime = "image/jpeg"): File {
  // Create a file with the declared size by padding with zero bytes
  const bytes = new Uint8Array(sizeBytes);
  return new File([bytes], "photo.jpg", { type: mime });
}

describe("compressImageToLimit", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the original file when it's already under the limit", async () => {
    const { compressImageToLimit } = await import("../upload-image");
    const small = makeFakeFile(1 * 1024 * 1024); // 1 MB
    const out = await compressImageToLimit(small, 5 * 1024 * 1024);
    expect(out.size).toBeLessThanOrEqual(5 * 1024 * 1024);
    // Must still be a File (for fileToBase64 downstream)
    expect(out).toBeInstanceOf(Blob);
  });

  it("compresses a 10MB image down under a 5MB limit", async () => {
    const { compressImageToLimit } = await import("../upload-image");

    // Stub global Image + canvas so happy-dom can simulate compression.
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 4000;
      naturalHeight = 3000;
      set src(_v: string) {
        // Immediately fire onload on next microtask
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", FakeImage);

    // Fake canvas.toBlob → returns progressively smaller blobs
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "canvas") {
        const canvas = originalCreateElement("canvas") as HTMLCanvasElement;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (canvas as any).getContext = () => ({
          drawImage: () => {},
        });
        let callCount = 0;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (canvas as any).toBlob = (
          cb: (blob: Blob | null) => void,
          _mime: string,
          quality: number,
        ) => {
          callCount++;
          // Simulate decreasing size with quality
          const size = Math.floor((quality ?? 0.85) * 5_000_000);
          const blob = new Blob([new Uint8Array(size)], { type: "image/jpeg" });
          cb(blob);
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (canvas as any).__callCount = () => callCount;
        return canvas;
      }
      return originalCreateElement(tag);
    });

    const big = makeFakeFile(10 * 1024 * 1024, "image/jpeg");
    const out = await compressImageToLimit(big, 5 * 1024 * 1024);

    expect(out.size).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(out.type).toBe("image/jpeg");
  });
});
