import { describe, it, expect, beforeEach, vi } from "vitest";

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

describe("share-target — immediate cache copy (Session 48)", () => {
  beforeEach(() => {
    readFile.mockReset();
    writeFile.mockReset();
    getUri.mockReset();
    addListener.mockReset();
  });

  it("copies shared content:// file into private cache before dispatching", async () => {
    readFile.mockResolvedValue({ data: "aGVsbG8=" }); // "hello" base64
    writeFile.mockResolvedValue(undefined);
    getUri.mockResolvedValue({ uri: "file:///data/data/app/cache/share-1234-photo.jpg" });

    const { initShareTargetListener } = await loadShareTarget();

    let received: { fileUri?: string; fileName?: string; mimeType?: string } | undefined;
    await initShareTargetListener((d) => {
      received = d;
    });

    expect(addListener).toHaveBeenCalledWith("shareReceived", expect.any(Function));
    const listener = addListener.mock.calls[0][1] as (e: unknown) => Promise<void>;

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
    expect(received?.fileUri).toBe("file:///data/data/app/cache/share-1234-photo.jpg");
    expect(received?.fileName).toBe("photo.jpg");
    expect(received?.mimeType).toBe("image/jpeg");
  });

  it("falls back to original URI when cache copy fails (low-RAM OOM)", async () => {
    readFile.mockRejectedValue(new Error("OOM"));

    const { initShareTargetListener } = await loadShareTarget();

    let received: { fileUri?: string } | undefined;
    await initShareTargetListener((d) => {
      received = d;
    });
    const listener = addListener.mock.calls[0][1] as (e: unknown) => Promise<void>;

    await listener({
      texts: [],
      files: [{ uri: "content://media/external/big-video", name: "video.mp4", mimeType: "video/mp4" }],
    });

    expect(received?.fileUri).toBe("content://media/external/big-video");
  });

  it("sanitizes filenames with path separators / odd characters", async () => {
    readFile.mockResolvedValue({ data: "QUJD" });
    writeFile.mockResolvedValue(undefined);
    getUri.mockResolvedValue({ uri: "file:///cache/share-1-_etc_passwd" });

    const { initShareTargetListener } = await loadShareTarget();
    await initShareTargetListener(() => undefined);
    const listener = addListener.mock.calls[0][1] as (e: unknown) => Promise<void>;

    await listener({
      texts: [],
      files: [{ uri: "content://x", name: "../../etc/passwd", mimeType: "text/plain" }],
    });

    const writeCall = writeFile.mock.calls[0][0] as { path: string };
    expect(writeCall.path).not.toContain("/");
    expect(writeCall.path).not.toContain("..");
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
