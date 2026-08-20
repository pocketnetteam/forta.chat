import { describe, it, expect, vi, beforeEach } from "vitest";

const mockStart = vi.fn((): Promise<void> => Promise.resolve());
const mockStop = vi.fn((): Promise<void> => Promise.resolve());
let mockIsAndroid = true;

vi.mock("./ai-inference-plugin", () => ({
  AiInferenceKeepAlive: {
    start: () => mockStart(),
    stop: () => mockStop(),
  },
}));

vi.mock("@/shared/lib/platform", () => ({
  get isAndroid() {
    return mockIsAndroid;
  },
}));

// eslint-disable-next-line import/first -- must follow vi.mock, matches native-foreground-download.adapter.test.ts's own ordering
import { startAiInferenceKeepAlive, stopAiInferenceKeepAlive } from "./ai-inference-keep-alive.adapter";

beforeEach(() => {
  vi.clearAllMocks();
  mockIsAndroid = true;
});

describe("ai-inference-keep-alive.adapter", () => {
  it("startAiInferenceKeepAlive() calls AiInferenceKeepAlive.start() on Android", async () => {
    await startAiInferenceKeepAlive();
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it("stopAiInferenceKeepAlive() calls AiInferenceKeepAlive.stop() on Android", async () => {
    await stopAiInferenceKeepAlive();
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it("is a no-op on non-Android platforms", async () => {
    mockIsAndroid = false;
    await startAiInferenceKeepAlive();
    await stopAiInferenceKeepAlive();
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockStop).not.toHaveBeenCalled();
  });

  it("start() never throws even if the native plugin call rejects", async () => {
    mockStart.mockRejectedValueOnce(new Error("startForegroundService rejected"));
    await expect(startAiInferenceKeepAlive()).resolves.toBeUndefined();
  });

  it("stop() never throws even if the native plugin call rejects", async () => {
    mockStop.mockRejectedValueOnce(new Error("service not running"));
    await expect(stopAiInferenceKeepAlive()).resolves.toBeUndefined();
  });
});
