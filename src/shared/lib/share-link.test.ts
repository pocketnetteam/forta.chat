import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the platform flag BEFORE importing the module under test so the
// dynamic import branches pick the right path.
vi.mock("@/shared/lib/platform/index", () => ({
  isNative: false,
}));

// @capacitor/share is imported dynamically inside shareLink — mocked so the
// web branch can be tested without pulling the native module.
const shareCall = vi.fn().mockResolvedValue(undefined);
vi.mock("@capacitor/share", () => ({
  Share: {
    share: (opts: unknown) => shareCall(opts),
  },
}));

import { copyToClipboard, shareLink } from "./share-link";

describe("copyToClipboard (web)", () => {
  beforeEach(() => {
    // no-op — retained for parallelism with other suites
  });

  it("uses navigator.clipboard.writeText when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await copyToClipboard("hello");
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to execCommand when clipboard API rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    // Track textarea lifecycle via a minimal DOM stub
    const exec = vi.fn().mockReturnValue(true);
    const appended: HTMLElement[] = [];
    const originalAppend = document.body.appendChild.bind(document.body);
    const originalRemove = document.body.removeChild.bind(document.body);
    document.body.appendChild = ((node: HTMLElement) => {
      appended.push(node);
      return originalAppend(node);
    }) as typeof document.body.appendChild;
    document.body.removeChild = ((node: HTMLElement) => {
      return originalRemove(node);
    }) as typeof document.body.removeChild;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (document as any).execCommand = exec;

    await copyToClipboard("fallback-text");

    expect(exec).toHaveBeenCalledWith("copy");
    expect(appended.length).toBe(1);
    expect(appended[0].tagName).toBe("TEXTAREA");
    expect((appended[0] as HTMLTextAreaElement).value).toBe("fallback-text");
  });

  it("falls back to execCommand when navigator.clipboard is missing entirely", async () => {
    vi.stubGlobal("navigator", {});
    const exec = vi.fn().mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (document as any).execCommand = exec;
    await copyToClipboard("no-clipboard-api");
    expect(exec).toHaveBeenCalledWith("copy");
  });

  it("throws when execCommand reports failure", async () => {
    vi.stubGlobal("navigator", {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (document as any).execCommand = vi.fn().mockReturnValue(false);
    await expect(copyToClipboard("boom")).rejects.toThrow();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
});

describe("shareLink (web)", () => {
  beforeEach(() => {
    shareCall.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses navigator.share when available", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { share });
    await shareLink({ url: "https://forta.chat/join?room=!r:s", title: "Invite" });
    expect(share).toHaveBeenCalledWith({
      url: "https://forta.chat/join?room=!r:s",
      title: "Invite",
      text: undefined,
    });
  });

  it("throws share_unavailable when navigator.share missing and not native", async () => {
    vi.stubGlobal("navigator", {});
    await expect(shareLink({ url: "https://forta.chat/join?room=!r:s" })).rejects.toThrow(
      /share_unavailable/,
    );
  });
});
