import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Profile / room / group avatars must always land as AVATAR_SIZE×AVATAR_SIZE
 * (200×200) JPEG — center-cropped. General photo compression (>5MB) is a
 * separate path and must not change this contract.
 */

function stubImageAndCanvas(origW: number, origH: number) {
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = origW;
    naturalHeight = origH;
    set src(_v: string) {
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal("Image", FakeImage);

  let lastCanvas: { width: number; height: number; sx?: number; sy?: number; sw?: number; sh?: number } | null = null;
  const originalCreateElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    if (tag === "canvas") {
      const canvas = originalCreateElement("canvas") as HTMLCanvasElement;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (canvas as any).getContext = () => ({
        imageSmoothingEnabled: true,
        imageSmoothingQuality: "high",
        drawImage: (
          _img: unknown,
          sx: number,
          sy: number,
          sw: number,
          sh: number,
          _dx: number,
          _dy: number,
          dw: number,
          dh: number,
        ) => {
          lastCanvas = {
            width: canvas.width,
            height: canvas.height,
            sx, sy, sw, sh,
          };
          // Sanity: destination must match canvas (full-bleed draw)
          expect(dw).toBe(canvas.width);
          expect(dh).toBe(canvas.height);
        },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (canvas as any).toBlob = (
        cb: (blob: Blob | null) => void,
        mime: string,
      ) => {
        // Tiny fake JPEG body — size is irrelevant for the contract test
        cb(new Blob([new Uint8Array(64)], { type: mime || "image/jpeg" }));
      };
      return canvas;
    }
    return originalCreateElement(tag);
  });

  return () => lastCanvas;
}

describe("resizeAvatarImage — fixed 200×200 square", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("exports AVATAR_SIZE = 200", async () => {
    const { AVATAR_SIZE } = await import("../upload-image");
    expect(AVATAR_SIZE).toBe(200);
  });

  it("outputs a 200×200 JPEG for a landscape photo (center-crop)", async () => {
    const getLast = stubImageAndCanvas(4000, 3000);
    const { resizeAvatarImage, AVATAR_SIZE } = await import("../upload-image");

    const file = new File([new Uint8Array(100)], "photo.jpg", { type: "image/jpeg" });
    const out = await resizeAvatarImage(file);

    expect(out.type).toBe("image/jpeg");
    expect(out.name).toMatch(/\.jpg$/);

    const drawn = getLast();
    expect(drawn).not.toBeNull();
    expect(drawn!.width).toBe(AVATAR_SIZE);
    expect(drawn!.height).toBe(AVATAR_SIZE);
    // Center-crop on landscape 4000×3000 → square side 3000, sx = 500
    expect(drawn!.sw).toBe(3000);
    expect(drawn!.sh).toBe(3000);
    expect(drawn!.sx).toBe(500);
    expect(drawn!.sy).toBe(0);
  });

  it("center-crops a portrait photo", async () => {
    const getLast = stubImageAndCanvas(1000, 2000);
    const { resizeAvatarImage } = await import("../upload-image");

    const file = new File([new Uint8Array(50)], "port.png", { type: "image/png" });
    await resizeAvatarImage(file);

    const drawn = getLast();
    expect(drawn!.sw).toBe(1000);
    expect(drawn!.sh).toBe(1000);
    expect(drawn!.sx).toBe(0);
    expect(drawn!.sy).toBe(500);
  });

  it("fileToAvatarBase64 returns a data URL after resize", async () => {
    stubImageAndCanvas(800, 600);
    const { fileToAvatarBase64 } = await import("../upload-image");

    const file = new File([new Uint8Array(40)], "a.webp", { type: "image/webp" });
    const dataUrl = await fileToAvatarBase64(file);
    expect(dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("rejects non-image files in fileToAvatarBase64", async () => {
    const { fileToAvatarBase64, ImageUploadError } = await import("../upload-image");
    const file = new File(["x"], "x.txt", { type: "text/plain" });
    await expect(fileToAvatarBase64(file)).rejects.toBeInstanceOf(ImageUploadError);
  });
});

describe("avatar call sites use fileToAvatarBase64 / resizeAvatarImage", () => {
  it("UserEditForm imports fileToAvatarBase64 (not fileToBase64)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../../features/user-management/ui/UserEditForm.vue"),
      "utf8",
    );
    expect(src).toMatch(/fileToAvatarBase64/);
    expect(src).not.toMatch(/fileToBase64/);
  });

  it("ProfileStep imports fileToAvatarBase64 (not fileToBase64)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../../features/auth/ui/register-form/steps/ProfileStep.vue"),
      "utf8",
    );
    expect(src).toMatch(/fileToAvatarBase64/);
    expect(src).not.toMatch(/fileToBase64/);
  });
});
