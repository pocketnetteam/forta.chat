import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Audit W2C-04: Android WebView cannot draw HEIC, so a picked iPhone photo had
 * no preview in the composer; the conversion ran only on send.
 */

const heic2any = vi.hoisted(() => vi.fn(async (_opts: unknown) => new Blob(["jpeg-bytes"], { type: "image/jpeg" })));
vi.mock("heic2any", () => ({ default: heic2any }));

const { useMediaUpload } = await import("./use-media-upload");

describe("useMediaUpload", () => {
  beforeEach(() => {
    heic2any.mockClear();
    let n = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:preview-${++n}`);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("previews and keeps a HEIC photo as JPEG", async () => {
    const upload = useMediaUpload();
    const heic = new File(["heic-bytes"], "IMG_0001.HEIC", { type: "image/heic" });

    upload.addFiles([heic]);
    await vi.waitFor(() => expect(upload.files.value[0].file.type).toBe("image/jpeg"));

    const item = upload.files.value[0];
    expect(item.file.name).toBe("IMG_0001.jpg");
    expect(item.previewUrl).toBe("blob:preview-2");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");
    expect(heic2any).toHaveBeenCalledTimes(1);
  });

  it("leaves other files alone", async () => {
    const upload = useMediaUpload();
    upload.addFiles([new File(["x"], "a.jpg", { type: "image/jpeg" }), new File(["y"], "v.mp4", { type: "video/mp4" })]);
    await Promise.resolve();
    expect(heic2any).not.toHaveBeenCalled();
    expect(upload.files.value.map((f) => f.file.name)).toEqual(["a.jpg", "v.mp4"]);
  });

  it("drops the converted preview of a photo removed while it converted", async () => {
    let release: (b: Blob) => void = () => {};
    heic2any.mockImplementationOnce(() => new Promise<Blob>((r) => { release = r; }));
    heic2any.mockClear();
    const upload = useMediaUpload();
    upload.addFiles([new File(["h"], "b.heic", { type: "image/heic" })]);
    upload.removeFile(0);

    release(new Blob(["jpeg"], { type: "image/jpeg" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(upload.files.value).toHaveLength(0);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });
});
