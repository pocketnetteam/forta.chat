// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { optimizeChatImage, isAnimatedImage, CHAT_IMAGE_MAX_SIDE } from "../upload-image";

// Photos sent to a chat used to go out as the camera original (4000+ px,
// 5-12 MB) and every recipient downloaded it in full. optimizeChatImage caps
// the longest side at 2048 px and re-encodes at quality 0.85.

interface ToBlobCall {
  w: number;
  h: number;
  mime: string;
  quality: number;
}

let imageSize = { w: 4000, h: 3000 };
let imageFails = false;
let imageCount = 0;
let encodedSize = 300_000;
/** Type the fake encoder reports; null = honour the requested mime. */
let encodedType: string | null = null;
let toBlobCalls: ToBlobCall[] = [];

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = imageSize.w;
  naturalHeight = imageSize.h;
  constructor() {
    imageCount++;
  }
  set src(_v: string) {
    queueMicrotask(() => (imageFails ? this.onerror?.() : this.onload?.()));
  }
}

function makeFile(size: number, mime: string, name = "photo.jpg", head?: Uint8Array): File {
  const bytes = new Uint8Array(size);
  if (head) bytes.set(head);
  return new File([bytes], name, { type: mime });
}

const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

/** RIFF....WEBPVP8X + 4-byte chunk size + flags byte (0x02 = animation). */
function webpHeader(animated: boolean): Uint8Array {
  const h = new Uint8Array(30);
  h.set(ascii("RIFF"), 0);
  h.set(ascii("WEBPVP8X"), 8);
  h[20] = animated ? 0x02 : 0x00;
  return h;
}

/** PNG signature stand-in + IHDR, optionally an acTL chunk before IDAT (APNG). */
function pngHeader(animated: boolean): Uint8Array {
  const chunks = ["_PNG____", "....IHDR", animated ? "....acTL" : "", "....IDAT"].join("");
  return new Uint8Array(ascii(chunks));
}

describe("optimizeChatImage", () => {
  beforeEach(() => {
    imageSize = { w: 4000, h: 3000 };
    imageFails = false;
    imageCount = 0;
    encodedSize = 300_000;
    encodedType = null;
    toBlobCalls = [];
    vi.stubGlobal("Image", FakeImage);

    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = originalCreateElement(tag);
      if (tag !== "canvas") return el;
      const canvas = el as HTMLCanvasElement;
      Object.assign(canvas, {
        getContext: () => ({ drawImage: () => {} }),
        toBlob: (cb: (b: Blob | null) => void, mime: string, quality: number) => {
          toBlobCalls.push({ w: canvas.width, h: canvas.height, mime, quality });
          cb(new Blob([new Uint8Array(encodedSize)], { type: encodedType ?? mime }));
        },
      });
      return canvas;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("downscales a camera JPEG to 2048 px on the longest side at q=0.85", async () => {
    const out = await optimizeChatImage(makeFile(6_000_000, "image/jpeg", "IMG_1.jpeg"));

    expect(toBlobCalls).toEqual([{ w: CHAT_IMAGE_MAX_SIDE, h: 1536, mime: "image/jpeg", quality: 0.85 }]);
    expect(out.type).toBe("image/jpeg");
    expect(out.size).toBe(300_000);
    expect(out.name).toBe("IMG_1.jpg");
  });

  it("scales a portrait photo by its height", async () => {
    imageSize = { w: 3000, h: 4000 };
    await optimizeChatImage(makeFile(6_000_000, "image/jpeg"));
    expect(toBlobCalls[0]).toMatchObject({ w: 1536, h: CHAT_IMAGE_MAX_SIDE });
  });

  it("re-encodes a heavy JPEG that is already within 2048 px without resizing", async () => {
    imageSize = { w: 1600, h: 1200 };
    const out = await optimizeChatImage(makeFile(2_000_000, "image/jpeg"));
    expect(toBlobCalls[0]).toMatchObject({ w: 1600, h: 1200, quality: 0.85 });
    expect(out.size).toBe(300_000);
  });

  it("keeps a small JPEG within 2048 px untouched", async () => {
    imageSize = { w: 1200, h: 900 };
    const file = makeFile(200_000, "image/jpeg");
    expect(await optimizeChatImage(file)).toBe(file);
    expect(toBlobCalls).toHaveLength(0);
  });

  it("keeps the original when the re-encode is not smaller", async () => {
    imageSize = { w: 1600, h: 1200 };
    encodedSize = 900_000;
    const file = makeFile(800_000, "image/jpeg");
    expect(await optimizeChatImage(file)).toBe(file);
  });

  it.each(["image/gif", "image/svg+xml", "image/heic", ""])("never touches %s", async (mime) => {
    const file = makeFile(6_000_000, mime, "x.bin");
    expect(await optimizeChatImage(file)).toBe(file);
    expect(imageCount).toBe(0);
  });

  it("keeps a PNG within 2048 px (lossless, may have transparency)", async () => {
    imageSize = { w: 1080, h: 1920 };
    const file = makeFile(3_000_000, "image/png", "shot.png");
    expect(await optimizeChatImage(file)).toBe(file);
    expect(toBlobCalls).toHaveLength(0);
  });

  it("downscales an oversized PNG and keeps it PNG", async () => {
    imageSize = { w: 2560, h: 1440 };
    const out = await optimizeChatImage(makeFile(5_000_000, "image/png", "shot.png"));
    expect(toBlobCalls[0]).toMatchObject({ w: CHAT_IMAGE_MAX_SIDE, h: 1152, mime: "image/png" });
    expect(out.type).toBe("image/png");
    expect(out.name).toBe("shot.png");
  });

  it("names the file after the type the encoder actually produced", async () => {
    encodedType = "image/png"; // iOS 15 has no WebP encoder
    const out = await optimizeChatImage(makeFile(6_000_000, "image/webp", "pic.webp"));
    expect(toBlobCalls[0].mime).toBe("image/webp");
    expect(out.type).toBe("image/png");
    expect(out.name).toBe("pic.png");
  });

  it("leaves an animated WebP untouched (canvas would keep only the first frame)", async () => {
    const file = makeFile(6_000_000, "image/webp", "sticker.webp", webpHeader(true));
    expect(await optimizeChatImage(file)).toBe(file);
    expect(imageCount).toBe(0);
  });

  it("leaves an APNG untouched", async () => {
    imageSize = { w: 2560, h: 1440 };
    const file = makeFile(5_000_000, "image/png", "anim.png", pngHeader(true));
    expect(await optimizeChatImage(file)).toBe(file);
    expect(imageCount).toBe(0);
  });

  it("detects animation only from the header flags", async () => {
    expect(await isAnimatedImage(makeFile(100, "image/webp", "a.webp", webpHeader(true)))).toBe(true);
    expect(await isAnimatedImage(makeFile(100, "image/webp", "s.webp", webpHeader(false)))).toBe(false);
    expect(await isAnimatedImage(makeFile(100, "image/png", "a.png", pngHeader(true)))).toBe(true);
    expect(await isAnimatedImage(makeFile(100, "image/png", "s.png", pngHeader(false)))).toBe(false);
  });

  it("sends the original when the image cannot be decoded", async () => {
    imageFails = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const file = makeFile(6_000_000, "image/jpeg");
    expect(await optimizeChatImage(file)).toBe(file);
  });
});
