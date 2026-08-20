import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FileSystemPort } from "local-ai";

// In-memory fake for the native ModelDownloader bridge — mirrors
// file-transfer-service.test.ts's pattern for TorFile, but mocks this
// module directly rather than @capacitor/core's registerPlugin (this
// module owns the registerPlugin() call, so mocking it here is simpler and
// keeps the test decoupled from Capacitor's exact API shape).
type DownloaderStatus = { state: "pending" | "running" | "paused" | "done" | "error"; progressPercent: number; errorMessage?: string };
const mockStart = vi.fn((..._args: unknown[]): Promise<void> => Promise.resolve());
const mockPause = vi.fn((..._args: unknown[]): Promise<void> => Promise.resolve());
const mockStop = vi.fn((..._args: unknown[]): Promise<void> => Promise.resolve());
const mockStatus = vi.fn((..._args: unknown[]): Promise<DownloaderStatus> => Promise.resolve({ state: "running", progressPercent: 0 }));

type ProgressCb = (e: { id: string; progressPercent: number }) => void;
type CompletedCb = (e: { id: string }) => void;
type FailedCb = (e: { id: string; error: string }) => void;
let progressCb: ProgressCb | null = null;
let completedCb: CompletedCb | null = null;
let failedCb: FailedCb | null = null;

function defaultAddListenerImpl(event: "progress" | "completed" | "failed", cb: ProgressCb | CompletedCb | FailedCb) {
  if (event === "progress") progressCb = cb as ProgressCb;
  if (event === "completed") completedCb = cb as CompletedCb;
  if (event === "failed") failedCb = cb as FailedCb;
  return Promise.resolve({ remove: () => {} });
}
const mockAddListener = vi.fn(defaultAddListenerImpl);

vi.mock("./model-download-plugin", () => ({
  ModelDownloader: {
    start: (...args: unknown[]) => mockStart(...args),
    pause: (...args: unknown[]) => mockPause(...args),
    stop: (...args: unknown[]) => mockStop(...args),
    status: (...args: unknown[]) => mockStatus(...args),
    addListener: (...args: unknown[]) => mockAddListener(...(args as [event: "progress", cb: ProgressCb])),
  },
}));

// eslint-disable-next-line import/first -- must follow vi.mock, matches file-transfer-service.test.ts's own ordering
import { NativeForegroundDownloadAdapter } from "./native-foreground-download.adapter";

function makeFakeFileSystem(): FileSystemPort {
  return {
    resolvePath: vi.fn((dir: string, filename: string) => `/${dir}/${filename}`),
    exists: vi.fn(async () => false),
    stat: vi.fn(async () => null),
    deleteFile: vi.fn(async () => {}),
    appendFile: vi.fn(async () => {}),
    writeFile: vi.fn(async () => {}),
    readFile: vi.fn(async () => new Uint8Array()),
    freeSpaceBytes: vi.fn(async () => 10e9),
  } as unknown as FileSystemPort;
}

beforeEach(() => {
  vi.clearAllMocks();
  // vi.clearAllMocks() clears call history but NOT a custom
  // mockImplementation() set by an earlier test — reset explicitly, or a
  // later test can flakily inherit a previous test's override.
  mockAddListener.mockImplementation(defaultAddListenerImpl);
  mockStatus.mockImplementation((..._args: unknown[]): Promise<DownloaderStatus> => Promise.resolve({ state: "running", progressPercent: 0 }));
  progressCb = null;
  completedCb = null;
  failedCb = null;
});

describe("NativeForegroundDownloadAdapter", () => {
  it("reports supportsResume: true", () => {
    const adapter = new NativeForegroundDownloadAdapter(makeFakeFileSystem());
    expect(adapter.supportsResume).toBe(true);
  });

  it("start() subscribes to the native listeners before calling ModelDownloader.start()", async () => {
    const adapter = new NativeForegroundDownloadAdapter(makeFakeFileSystem());
    const callOrder: string[] = [];
    mockAddListener.mockImplementation(async (event: "progress" | "completed" | "failed", cb) => {
      callOrder.push(`addListener:${event}`);
      if (event === "progress") progressCb = cb as ProgressCb;
      return { remove: () => {} };
    });
    mockStart.mockImplementation(async () => {
      callOrder.push("start");
    });

    await adapter.start({ id: "k1", url: "https://x/model.gguf", destinationPath: "/models/model.gguf" });

    expect(callOrder).toEqual(["addListener:progress", "addListener:completed", "addListener:failed", "start"]);
    expect(mockStart).toHaveBeenCalledWith({ id: "k1", url: "https://x/model.gguf", destinationPath: "/models/model.gguf" });
  });

  it("relays native progress/completed/failed events to every registered onProgress/onCompleted/onFailed callback", async () => {
    const adapter = new NativeForegroundDownloadAdapter(makeFakeFileSystem());
    await adapter.start({ id: "k1", url: "https://x/model.gguf", destinationPath: "/models/model.gguf" });

    const progressEvents: Array<{ id: string; progressPercent: number }> = [];
    const completedEvents: Array<{ id: string }> = [];
    const failedEvents: Array<{ id: string; error: string }> = [];
    adapter.onProgress((e) => progressEvents.push(e));
    adapter.onProgress((e) => progressEvents.push(e)); // second subscriber — both should fire (Set-based fanout)
    adapter.onCompleted((e) => completedEvents.push(e));
    adapter.onFailed((e) => failedEvents.push(e));

    progressCb!({ id: "k1", progressPercent: 42 });
    completedCb!({ id: "k1" });
    failedCb!({ id: "k1", error: "boom" });

    expect(progressEvents).toEqual([
      { id: "k1", progressPercent: 42 },
      { id: "k1", progressPercent: 42 },
    ]);
    expect(completedEvents).toEqual([{ id: "k1" }]);
    expect(failedEvents).toEqual([{ id: "k1", error: "boom" }]);
  });

  it("the Unsubscribe function returned by onProgress() stops further relays to that callback", async () => {
    const adapter = new NativeForegroundDownloadAdapter(makeFakeFileSystem());
    await adapter.start({ id: "k1", url: "https://x/model.gguf", destinationPath: "/models/model.gguf" });

    const events: number[] = [];
    const unsubscribe = adapter.onProgress((e) => events.push(e.progressPercent));
    progressCb!({ id: "k1", progressPercent: 10 });
    unsubscribe();
    progressCb!({ id: "k1", progressPercent: 20 });

    expect(events).toEqual([10]);
  });

  it("pause() calls ModelDownloader.pause({ id })", async () => {
    const adapter = new NativeForegroundDownloadAdapter(makeFakeFileSystem());
    await adapter.pause("k1");
    expect(mockPause).toHaveBeenCalledWith({ id: "k1" });
  });

  it("resume() re-calls start() with the url/destinationPath/headers remembered from the original start()", async () => {
    const adapter = new NativeForegroundDownloadAdapter(makeFakeFileSystem());
    await adapter.start({
      id: "k1",
      url: "https://x/model.gguf",
      destinationPath: "/models/model.gguf",
      headers: { "X-Test": "1" },
    });
    mockStart.mockClear();

    await adapter.resume("k1");

    expect(mockStart).toHaveBeenCalledWith({
      id: "k1",
      url: "https://x/model.gguf",
      destinationPath: "/models/model.gguf",
      headers: { "X-Test": "1" },
    });
  });

  it("resume() is a no-op when there is no remembered task for that id", async () => {
    const adapter = new NativeForegroundDownloadAdapter(makeFakeFileSystem());
    await adapter.resume("never-started");
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("stop() with discardPartial deletes the remembered destinationPath via FileSystemPort", async () => {
    const fileSystem = makeFakeFileSystem();
    const adapter = new NativeForegroundDownloadAdapter(fileSystem);
    await adapter.start({ id: "k1", url: "https://x/model.gguf", destinationPath: "/models/model.gguf" });

    await adapter.stop("k1", { discardPartial: true });

    expect(mockStop).toHaveBeenCalledWith({ id: "k1" });
    expect(fileSystem.deleteFile).toHaveBeenCalledWith("/models/model.gguf");
  });

  it("stop() without discardPartial never touches the filesystem", async () => {
    const fileSystem = makeFakeFileSystem();
    const adapter = new NativeForegroundDownloadAdapter(fileSystem);
    await adapter.start({ id: "k1", url: "https://x/model.gguf", destinationPath: "/models/model.gguf" });

    await adapter.stop("k1");

    expect(fileSystem.deleteFile).not.toHaveBeenCalled();
  });

  it("stop() forgets the task — a later resume() for the same id becomes a no-op", async () => {
    const adapter = new NativeForegroundDownloadAdapter(makeFakeFileSystem());
    await adapter.start({ id: "k1", url: "https://x/model.gguf", destinationPath: "/models/model.gguf" });
    await adapter.stop("k1");
    mockStart.mockClear();

    await adapter.resume("k1");

    expect(mockStart).not.toHaveBeenCalled();
  });

  it("status() delegates to ModelDownloader.status({ id })", async () => {
    mockStatus.mockResolvedValue({ state: "paused", progressPercent: 37 });
    const adapter = new NativeForegroundDownloadAdapter(makeFakeFileSystem());

    const result = await adapter.status("k1");

    expect(mockStatus).toHaveBeenCalledWith({ id: "k1" });
    expect(result).toEqual({ state: "paused", progressPercent: 37 });
  });
});
