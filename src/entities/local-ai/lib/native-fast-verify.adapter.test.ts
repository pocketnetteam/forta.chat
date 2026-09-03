import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory fake for the native ModelDownloader.verify bridge — mirrors
// native-foreground-download.adapter.test.ts's pattern of mocking this
// module directly rather than @capacitor/core's registerPlugin.
const mockVerify = vi.fn((..._args: unknown[]): Promise<{ valid: boolean }> => Promise.resolve({ valid: true }));

type VerifyProgressCb = (e: { id: string; bytesHashed: number }) => void;
let verifyProgressCb: VerifyProgressCb | null = null;
const removeSpy = vi.fn();

function defaultAddListenerImpl(event: string, cb: VerifyProgressCb) {
  if (event === "verifyProgress") verifyProgressCb = cb;
  return Promise.resolve({ remove: removeSpy });
}
const mockAddListener = vi.fn(defaultAddListenerImpl);

vi.mock("./model-download-plugin", () => ({
  ModelDownloader: {
    verify: (...args: unknown[]) => mockVerify(...args),
    addListener: (...args: unknown[]) => mockAddListener(...(args as [string, VerifyProgressCb])),
  },
}));

// eslint-disable-next-line import/first -- must follow vi.mock, matches native-foreground-download.adapter.test.ts's own ordering
import { NativeFastVerifyAdapter } from "./native-fast-verify.adapter";

beforeEach(() => {
  vi.clearAllMocks();
  // vi.clearAllMocks() clears call history but NOT a custom
  // mockImplementation() set by an earlier test — reset explicitly.
  mockAddListener.mockImplementation(defaultAddListenerImpl);
  mockVerify.mockImplementation((..._args: unknown[]) => Promise.resolve({ valid: true }));
  verifyProgressCb = null;
});

describe("NativeFastVerifyAdapter", () => {
  it("calls ModelDownloader.verify() with path/expectedSha256 and a generated id, and returns its valid flag", async () => {
    const adapter = new NativeFastVerifyAdapter();

    const result = await adapter.sha256File("models/model.gguf", "abc123");

    expect(result).toBe(true);
    expect(mockVerify).toHaveBeenCalledTimes(1);
    const call = mockVerify.mock.calls[0]![0] as { id: string; path: string; expectedSha256: string };
    expect(call.path).toBe("models/model.gguf");
    expect(call.expectedSha256).toBe("abc123");
    expect(typeof call.id).toBe("string");
    expect(call.id.length).toBeGreaterThan(0);
  });

  it("returns false when the native side reports an invalid checksum", async () => {
    mockVerify.mockResolvedValue({ valid: false });
    const adapter = new NativeFastVerifyAdapter();

    const result = await adapter.sha256File("models/model.gguf", "abc123");

    expect(result).toBe(false);
  });

  it("subscribes to verifyProgress and relays only events matching this call's id, when onProgress is given", async () => {
    mockVerify.mockImplementation(async (...args: unknown[]) => {
      const { id } = args[0] as { id: string };
      verifyProgressCb!({ id, bytesHashed: 500 });
      verifyProgressCb!({ id: "some-other-call-id", bytesHashed: 999 }); // must be ignored
      return { valid: true };
    });
    const adapter = new NativeFastVerifyAdapter();
    const progressed: number[] = [];

    await adapter.sha256File("models/model.gguf", "abc123", (bytesHashed) => progressed.push(bytesHashed));

    expect(progressed).toEqual([500]);
  });

  it("does not subscribe to verifyProgress at all when no onProgress callback is given", async () => {
    const adapter = new NativeFastVerifyAdapter();

    await adapter.sha256File("models/model.gguf", "abc123");

    expect(mockAddListener).not.toHaveBeenCalled();
  });

  it("removes the verifyProgress listener after the call resolves", async () => {
    const adapter = new NativeFastVerifyAdapter();

    await adapter.sha256File("models/model.gguf", "abc123", () => {});

    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it("removes the verifyProgress listener even if verify() rejects", async () => {
    mockVerify.mockRejectedValue(new Error("native verify failed"));
    const adapter = new NativeFastVerifyAdapter();

    await expect(adapter.sha256File("models/model.gguf", "abc123", () => {})).rejects.toThrow("native verify failed");

    expect(removeSpy).toHaveBeenCalledTimes(1);
  });
});
