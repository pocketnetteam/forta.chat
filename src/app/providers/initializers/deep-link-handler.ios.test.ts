/**
 * iOS-specific integration coverage for `setupDeepLinkHandler`. Lives in its
 * own test file because the platform mock here resolves `isIOS: true` /
 * `isNative: true`, which would invert the assumptions of the sibling
 * `deep-link-handler.test.ts` (web-mode default).
 *
 * Verifies the Universal Links cold-start recovery path: setupDeepLinkHandler
 * drives App.getLaunchUrl(), routes the result through the same buffer that
 * appUrlOpen feeds, and dedupes against a replayed appUrlOpen for the same URL.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// `vi.mock` is hoisted to the very top of the file, ABOVE plain `const`
// declarations — so any state its factory references must be created via
// `vi.hoisted` to land in scope at the right time. Without this, the factory
// captures a fresh binding distinct from the one the test assertions observe,
// silently breaking `toHaveBeenCalled*` even though the underlying call did
// happen.
const ioMocks = vi.hoisted(() => ({
  getLaunchUrlMock: vi.fn<() => Promise<{ url: string } | undefined>>(),
  addListenerMock: vi.fn<
    (
      eventName: string,
      cb: (event: { url: string }) => void,
    ) => Promise<{ remove: () => void }>
  >(),
  capturedAppUrlOpenListener: null as ((event: { url: string }) => void) | null,
}));

vi.mock("@capacitor/app", () => ({
  App: {
    addListener: (eventName: string, cb: (event: { url: string }) => void) => {
      if (eventName === "appUrlOpen") {
        ioMocks.capturedAppUrlOpenListener = cb;
      }
      return ioMocks.addListenerMock(eventName, cb);
    },
    getLaunchUrl: () => ioMocks.getLaunchUrlMock(),
  },
}));

vi.mock("@/shared/lib/platform", () => ({
  isNative: true,
  isIOS: true,
}));

import {
  registerDeepLinkHandlers,
  resetDeepLinkHandlerForTesting,
  setupDeepLinkHandler,
} from "./deep-link-handler";

const VALID_ADDR = "PMyAddress1234567890ABCDEFGHIJKLMN";

async function flushSetupMicrotasks(): Promise<void> {
  // setupDeepLinkHandler kicks off `import("@capacitor/app").then(async ...)`.
  // Vitest evaluates the dynamic import in a real event-loop tick (not just a
  // microtask hop), so a microtask flush isn't enough. A short macrotask wait
  // followed by a microtask flush covers both the import and the awaited
  // getLaunchUrl call.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe("deep-link-handler — iOS setupDeepLinkHandler integration", () => {
  beforeEach(() => {
    resetDeepLinkHandlerForTesting();
    ioMocks.capturedAppUrlOpenListener = null;
    ioMocks.getLaunchUrlMock.mockReset();
    ioMocks.getLaunchUrlMock.mockResolvedValue(undefined);
    ioMocks.addListenerMock.mockReset();
    ioMocks.addListenerMock.mockResolvedValue({ remove: vi.fn() });
  });

  it("calls App.getLaunchUrl and attaches the appUrlOpen listener on iOS", async () => {
    setupDeepLinkHandler();
    await flushSetupMicrotasks();

    expect(ioMocks.getLaunchUrlMock).toHaveBeenCalledTimes(1);
    expect(ioMocks.addListenerMock).toHaveBeenCalledWith("appUrlOpen", expect.any(Function));
  });

  it("drains a cold-start launch URL into the deep-link handlers", async () => {
    ioMocks.getLaunchUrlMock.mockResolvedValue({
      url: `https://forta.chat/invite?ref=${VALID_ADDR}`,
    });

    setupDeepLinkHandler();
    await flushSetupMicrotasks();

    const onInvite = vi.fn();
    const onJoin = vi.fn();
    registerDeepLinkHandlers({ onInvite, onJoin });

    expect(onInvite).toHaveBeenCalledTimes(1);
    expect(onInvite).toHaveBeenCalledWith({ address: VALID_ADDR });
    expect(onJoin).not.toHaveBeenCalled();
  });

  it("dedupes a launch URL that Capacitor also replays through appUrlOpen", async () => {
    const url = `https://forta.chat/invite?ref=${VALID_ADDR}`;
    ioMocks.getLaunchUrlMock.mockResolvedValue({ url });

    setupDeepLinkHandler();
    await flushSetupMicrotasks();

    const onInvite = vi.fn();
    const onJoin = vi.fn();
    registerDeepLinkHandlers({ onInvite, onJoin });
    expect(onInvite).toHaveBeenCalledTimes(1);

    // Capacitor races and replays the same URL through appUrlOpen — must be
    // dropped by the cold-start dedup slot, not invoke the handler twice.
    expect(ioMocks.capturedAppUrlOpenListener).not.toBeNull();
    ioMocks.capturedAppUrlOpenListener!({ url });

    expect(onInvite).toHaveBeenCalledTimes(1);
  });

  it("survives an App.getLaunchUrl rejection without breaking listener wiring", async () => {
    ioMocks.getLaunchUrlMock.mockRejectedValue(new Error("plugin failed"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      setupDeepLinkHandler();
      await flushSetupMicrotasks();

      expect(ioMocks.getLaunchUrlMock).toHaveBeenCalledTimes(1);
      expect(ioMocks.addListenerMock).toHaveBeenCalledWith("appUrlOpen", expect.any(Function));

      // Listener still routes a later URL via appUrlOpen.
      const onInvite = vi.fn();
      const onJoin = vi.fn();
      registerDeepLinkHandlers({ onInvite, onJoin });

      expect(ioMocks.capturedAppUrlOpenListener).not.toBeNull();
      ioMocks.capturedAppUrlOpenListener!({
        url: `https://forta.chat/invite?ref=${VALID_ADDR}`,
      });
      expect(onInvite).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does nothing extra when App.getLaunchUrl resolves to nothing", async () => {
    setupDeepLinkHandler();
    await flushSetupMicrotasks();

    const onInvite = vi.fn();
    const onJoin = vi.fn();
    registerDeepLinkHandlers({ onInvite, onJoin });

    expect(onInvite).not.toHaveBeenCalled();
    expect(onJoin).not.toHaveBeenCalled();
  });
});
