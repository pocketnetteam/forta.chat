import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ExternalShareData } from "../share-target";

// Mocks live at module scope — vitest hoists vi.mock() calls. Each test
// resets the underlying spies via the exposed handles.
const readFile = vi.fn();
const writeFile = vi.fn();
const getUri = vi.fn();

vi.mock("@capacitor/filesystem", () => ({
  Filesystem: {
    readFile: (...args: unknown[]) => readFile(...args),
    writeFile: (...args: unknown[]) => writeFile(...args),
    getUri: (...args: unknown[]) => getUri(...args),
  },
  Directory: { Cache: "CACHE" },
}));

const addListener = vi.fn();
vi.mock("@capgo/capacitor-share-target", () => ({
  CapacitorShareTarget: {
    addListener: (...args: unknown[]) => addListener(...args),
  },
}));

vi.mock("@/shared/lib/platform", () => ({ isNative: true }));

// We must re-import the SUT after resetting mocks so the module's internal
// `listenerRegistered` flag goes back to false between tests.
async function loadShareTarget() {
  vi.resetModules();
  return await import("../share-target");
}

async function registerAndGetListener(onShare: (d: ExternalShareData) => void = () => undefined) {
  const { initShareTargetListener } = await loadShareTarget();
  await initShareTargetListener(onShare);
  return addListener.mock.calls[0][1] as (e: unknown) => Promise<void>;
}

describe("share-target listener — shared file resolution", () => {
  beforeEach(() => {
    readFile.mockReset();
    writeFile.mockReset();
    getUri.mockReset();
    addListener.mockReset();
  });

  // Regression: the capgo plugin already copies into cache/shared_files and
  // returns a bare path. Re-reading it through the base64 bridge tripled
  // memory and OOM'd large shares.
  it("keeps the native sandbox copy as-is — no second base64 copy", async () => {
    let received: ExternalShareData | undefined;
    const listener = await registerAndGetListener((d) => {
      received = d;
    });

    await listener({
      texts: [],
      files: [
        {
          uri: "/data/user/0/com.forta.chat/cache/shared_files/1_0_Screenshot.png",
          name: "Screenshot.png",
          mimeType: "image/png",
        },
      ],
    });

    expect(readFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(received?.files).toEqual([
      {
        uri: "/data/user/0/com.forta.chat/cache/shared_files/1_0_Screenshot.png",
        name: "Screenshot.png",
        mimeType: "image/png",
      },
    ]);
  });

  it("forwards every file of a multi-file share, in order", async () => {
    let received: ExternalShareData | undefined;
    const listener = await registerAndGetListener((d) => {
      received = d;
    });

    await listener({
      texts: ["caption"],
      files: [
        { uri: "/c/1_0_a.png", name: "a.png", mimeType: "image/png" },
        { uri: "/c/1_1_b.jpg", name: "b.jpg", mimeType: "image/jpeg" },
        { uri: "/c/1_2_c.mp4", name: "c.mp4", mimeType: "video/mp4" },
      ],
    });

    expect(received?.text).toBe("caption");
    expect(received?.files?.map((f) => f.name)).toEqual(["a.png", "b.jpg", "c.mp4"]);
  });

  it("copies a content:// URI (native copy failed) into private cache", async () => {
    readFile.mockResolvedValue({ data: "aGVsbG8=" });
    writeFile.mockResolvedValue(undefined);
    getUri.mockResolvedValue({ uri: "file:///data/data/app/cache/share-1234-photo.jpg" });

    let received: ExternalShareData | undefined;
    const listener = await registerAndGetListener((d) => {
      received = d;
    });
    expect(addListener).toHaveBeenCalledWith("shareReceived", expect.any(Function));

    await listener({
      texts: [],
      files: [{ uri: "content://media/external/123", name: "photo.jpg", mimeType: "image/jpeg" }],
    });

    expect(readFile).toHaveBeenCalledWith({ path: "content://media/external/123" });
    expect(writeFile).toHaveBeenCalledWith(
      expect.objectContaining({
        data: "aGVsbG8=",
        directory: "CACHE",
        path: expect.stringMatching(/^share-\d+-photo\.jpg$/),
      }),
    );
    expect(received?.files?.[0]).toEqual({
      uri: "file:///data/data/app/cache/share-1234-photo.jpg",
      name: "photo.jpg",
      mimeType: "image/jpeg",
    });
  });

  it("falls back to the original content:// URI when the cache copy fails (low-RAM OOM)", async () => {
    readFile.mockRejectedValue(new Error("OOM"));

    let received: ExternalShareData | undefined;
    const listener = await registerAndGetListener((d) => {
      received = d;
    });

    await listener({
      texts: [],
      files: [{ uri: "content://media/external/big-video", name: "video.mp4", mimeType: "video/mp4" }],
    });

    expect(received?.files?.[0].uri).toBe("content://media/external/big-video");
  });

  it("sanitizes filenames with path separators / odd characters", async () => {
    readFile.mockResolvedValue({ data: "QUJD" });
    writeFile.mockResolvedValue(undefined);
    getUri.mockResolvedValue({ uri: "file:///cache/share-1-_etc_passwd" });

    const listener = await registerAndGetListener();

    await listener({
      texts: [],
      files: [{ uri: "content://x", name: "../../etc/passwd", mimeType: "text/plain" }],
    });

    const writeCall = writeFile.mock.calls[0][0] as { path: string };
    expect(writeCall.path).not.toContain("/");
    expect(writeCall.path).not.toContain("..");
  });

  it("ignores events with neither text nor files", async () => {
    const onShare = vi.fn();
    const listener = await registerAndGetListener(onShare);

    await listener({ texts: [], files: [] });

    expect(onShare).not.toHaveBeenCalled();
  });

  it("idempotent: second invocation does not register a second listener", async () => {
    const { initShareTargetListener } = await loadShareTarget();
    await initShareTargetListener(() => undefined);
    await initShareTargetListener(() => undefined);
    expect(addListener).toHaveBeenCalledTimes(1);
  });

  it("does nothing on web (isNative=false)", async () => {
    vi.resetModules();
    vi.doMock("@/shared/lib/platform", () => ({ isNative: false }));
    const { initShareTargetListener } = await import("../share-target");
    await initShareTargetListener(() => undefined);
    expect(addListener).not.toHaveBeenCalled();
  });
});
