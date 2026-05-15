import { describe, it, expect, beforeEach, vi } from "vitest";

// Capacitor App plugin is only used on native; in happy-dom the listener is a
// no-op. Mock it anyway so the module can safely import without pulling the
// actual plugin. iOS-specific integration (App.getLaunchUrl + Universal Links
// cold-start path) lives in `deep-link-handler.ios.test.ts` so that file can
// own its own `isIOS: true` platform mock without conflicting with this one.
vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
    getLaunchUrl: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/shared/lib/platform", () => ({
  isNative: false,
  isIOS: false,
}));

import {
  onColdStartLaunchUrlForTesting,
  onDeepLinkOpen,
  registerDeepLinkHandlers,
  resetDeepLinkHandlerForTesting,
} from "./deep-link-handler";

const VALID_ADDR = "PMyAddress1234567890ABCDEFGHIJKLMN";
const ROOM_ID = "!abcdef123:matrix.pocketnet.app";

describe("deep-link-handler", () => {
  beforeEach(() => {
    resetDeepLinkHandlerForTesting();
  });

  it("buffers URLs arriving before handlers are registered", () => {
    const onInvite = vi.fn();
    const onJoin = vi.fn();

    // Early URL (e.g. cold-start intent) arrives before router is ready.
    onDeepLinkOpen(`https://forta.chat/invite?ref=${VALID_ADDR}`);
    expect(onInvite).not.toHaveBeenCalled();

    // Router now ready → handlers registered, buffer drains.
    registerDeepLinkHandlers({ onInvite, onJoin });
    expect(onInvite).toHaveBeenCalledTimes(1);
    expect(onInvite).toHaveBeenCalledWith({ address: VALID_ADDR });
    expect(onJoin).not.toHaveBeenCalled();
  });

  it("delivers URLs synchronously once handlers are registered", () => {
    const onInvite = vi.fn();
    const onJoin = vi.fn();
    registerDeepLinkHandlers({ onInvite, onJoin });

    onDeepLinkOpen(`https://forta.chat/invite?ref=${VALID_ADDR}`);
    expect(onInvite).toHaveBeenCalledTimes(1);
    expect(onInvite).toHaveBeenCalledWith({ address: VALID_ADDR });
  });

  it("drains multiple buffered URLs in order", () => {
    const onInvite = vi.fn();
    const onJoin = vi.fn();

    onDeepLinkOpen(`https://forta.chat/invite?ref=${VALID_ADDR}`);
    onDeepLinkOpen(`https://forta.chat/join?room=${encodeURIComponent(ROOM_ID)}`);

    registerDeepLinkHandlers({ onInvite, onJoin });

    expect(onInvite).toHaveBeenCalledTimes(1);
    expect(onJoin).toHaveBeenCalledTimes(1);
    expect(onInvite).toHaveBeenCalledWith({ address: VALID_ADDR });
    expect(onJoin).toHaveBeenCalledWith({ roomId: ROOM_ID });
  });

  it("silently drops unparseable URLs (does not throw)", () => {
    const onInvite = vi.fn();
    const onJoin = vi.fn();
    registerDeepLinkHandlers({ onInvite, onJoin });

    expect(() => onDeepLinkOpen("not a url")).not.toThrow();
    expect(() => onDeepLinkOpen("https://evil.com/invite?ref=X")).not.toThrow();
    expect(onInvite).not.toHaveBeenCalled();
    expect(onJoin).not.toHaveBeenCalled();
  });

  it("routes custom scheme forta:// URLs", () => {
    const onInvite = vi.fn();
    const onJoin = vi.fn();
    registerDeepLinkHandlers({ onInvite, onJoin });

    onDeepLinkOpen(`forta://invite?ref=${VALID_ADDR}`);
    expect(onInvite).toHaveBeenCalledWith({ address: VALID_ADDR });
  });

  it("routes hash-based invite URLs (legacy web format)", () => {
    const onInvite = vi.fn();
    const onJoin = vi.fn();
    registerDeepLinkHandlers({ onInvite, onJoin });

    onDeepLinkOpen(`https://forta.chat/#/invite?ref=${VALID_ADDR}`);
    expect(onInvite).toHaveBeenCalledWith({ address: VALID_ADDR });
  });

  it("does not re-deliver a URL that was drained on register", () => {
    const onInvite = vi.fn();
    const onJoin = vi.fn();

    onDeepLinkOpen(`https://forta.chat/invite?ref=${VALID_ADDR}`);
    registerDeepLinkHandlers({ onInvite, onJoin });
    expect(onInvite).toHaveBeenCalledTimes(1);

    // Re-registering with a fresh handler should not replay the buffer —
    // the URL has already been consumed.
    const onInvite2 = vi.fn();
    registerDeepLinkHandlers({ onInvite: onInvite2, onJoin });
    expect(onInvite2).not.toHaveBeenCalled();
  });

  it("fires onMalformed for a forta host URL with missing ref", () => {
    const onInvite = vi.fn();
    const onJoin = vi.fn();
    const onMalformed = vi.fn();
    registerDeepLinkHandlers({ onInvite, onJoin, onMalformed });

    onDeepLinkOpen("https://forta.chat/invite");
    expect(onMalformed).toHaveBeenCalledWith("https://forta.chat/invite");
    expect(onInvite).not.toHaveBeenCalled();
  });

  it("fires onMalformed for forta:// custom scheme with bad ref", () => {
    const onInvite = vi.fn();
    const onJoin = vi.fn();
    const onMalformed = vi.fn();
    registerDeepLinkHandlers({ onInvite, onJoin, onMalformed });

    onDeepLinkOpen("forta://invite?ref=shortbad");
    expect(onMalformed).toHaveBeenCalledTimes(1);
    expect(onInvite).not.toHaveBeenCalled();
  });

  it("does not fire onMalformed for unrelated external URLs", () => {
    const onInvite = vi.fn();
    const onJoin = vi.fn();
    const onMalformed = vi.fn();
    registerDeepLinkHandlers({ onInvite, onJoin, onMalformed });

    onDeepLinkOpen("https://example.com/anything");
    onDeepLinkOpen("not a url");
    expect(onMalformed).not.toHaveBeenCalled();
  });

  describe("forta://share (iOS Share Extension callback)", () => {
    it("silently drops forta://share — no handler fires", () => {
      const onInvite = vi.fn();
      const onJoin = vi.fn();
      const onMalformed = vi.fn();
      registerDeepLinkHandlers({ onInvite, onJoin, onMalformed });

      onDeepLinkOpen("forta://share");
      onDeepLinkOpen("forta://share/");
      onDeepLinkOpen("forta://share?from=ext");

      expect(onInvite).not.toHaveBeenCalled();
      expect(onJoin).not.toHaveBeenCalled();
      // Critical: the Share Extension wakes the app via this URL after
      // writing the payload to the App Group; users must NOT see an
      // "invalid invite link" toast for it.
      expect(onMalformed).not.toHaveBeenCalled();
    });

    it("does not occupy the cold-start buffer with forta://share", () => {
      // 16 share-extension URLs arriving before handlers register must
      // not crowd out a real invite URL that arrives after them.
      for (let i = 0; i < 32; i++) onDeepLinkOpen("forta://share");
      onDeepLinkOpen(`forta://invite?ref=${VALID_ADDR}`);

      const onInvite = vi.fn();
      const onJoin = vi.fn();
      registerDeepLinkHandlers({ onInvite, onJoin });

      expect(onInvite).toHaveBeenCalledTimes(1);
      expect(onInvite).toHaveBeenCalledWith({ address: VALID_ADDR });
    });

    it("does not treat forta:// URLs with other hosts as system signals", () => {
      const onInvite = vi.fn();
      const onJoin = vi.fn();
      const onMalformed = vi.fn();
      registerDeepLinkHandlers({ onInvite, onJoin, onMalformed });

      // `forta://invite` (no params) is still a malformed user-facing
      // invite — the system-signal short-circuit must not eat it.
      onDeepLinkOpen("forta://invite");
      expect(onMalformed).toHaveBeenCalledTimes(1);
    });
  });

  // iOS Universal Links: App.getLaunchUrl() recovers a cold-start URL that
  // fired before the JS appUrlOpen listener was alive. The dedup slot prevents
  // double-dispatch if Capacitor later also replays the same URL.
  describe("iOS cold-start launch URL", () => {
    it("dispatches a cold-start launch URL once handlers are registered", () => {
      const onInvite = vi.fn();
      const onJoin = vi.fn();

      onColdStartLaunchUrlForTesting(`https://forta.chat/invite?ref=${VALID_ADDR}`);
      expect(onInvite).not.toHaveBeenCalled();

      registerDeepLinkHandlers({ onInvite, onJoin });
      expect(onInvite).toHaveBeenCalledTimes(1);
      expect(onInvite).toHaveBeenCalledWith({ address: VALID_ADDR });
    });

    it("dedupes a listener replay of the same URL that came via getLaunchUrl", () => {
      const onInvite = vi.fn();
      const onJoin = vi.fn();
      registerDeepLinkHandlers({ onInvite, onJoin });

      const url = `https://forta.chat/invite?ref=${VALID_ADDR}`;
      onColdStartLaunchUrlForTesting(url);
      // Capacitor races and also fires appUrlOpen with the same URL during boot.
      onDeepLinkOpen(url);

      expect(onInvite).toHaveBeenCalledTimes(1);
    });

    it("only dedupes the first replay (single-shot)", () => {
      const onInvite = vi.fn();
      const onJoin = vi.fn();
      registerDeepLinkHandlers({ onInvite, onJoin });

      const url = `https://forta.chat/invite?ref=${VALID_ADDR}`;
      onColdStartLaunchUrlForTesting(url);
      onDeepLinkOpen(url); // consumes the dedup slot
      onDeepLinkOpen(url); // genuine retap — must route

      expect(onInvite).toHaveBeenCalledTimes(2);
    });

    it("does not dedupe a different URL arriving via the listener", () => {
      const onInvite = vi.fn();
      const onJoin = vi.fn();
      registerDeepLinkHandlers({ onInvite, onJoin });

      onColdStartLaunchUrlForTesting(`https://forta.chat/invite?ref=${VALID_ADDR}`);
      onDeepLinkOpen(`https://forta.chat/join?room=${encodeURIComponent(ROOM_ID)}`);

      expect(onInvite).toHaveBeenCalledTimes(1);
      expect(onJoin).toHaveBeenCalledTimes(1);
    });

    it("clears the dedup slot after the window elapses", () => {
      vi.useFakeTimers();
      try {
        const onInvite = vi.fn();
        const onJoin = vi.fn();
        registerDeepLinkHandlers({ onInvite, onJoin });

        const url = `https://forta.chat/invite?ref=${VALID_ADDR}`;
        onColdStartLaunchUrlForTesting(url);
        vi.advanceTimersByTime(6_000); // > IOS_COLD_START_DEDUP_MS (5s)
        onDeepLinkOpen(url);

        // Cold-start already routed once; after the window the same URL via
        // the listener is a fresh event, not a dedupable replay.
        expect(onInvite).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("ignores forta://share for the cold-start path too", () => {
      const onInvite = vi.fn();
      const onJoin = vi.fn();
      const onMalformed = vi.fn();
      registerDeepLinkHandlers({ onInvite, onJoin, onMalformed });

      // If the iOS Share Extension wakes the app, App.getLaunchUrl() may also
      // return forta://share. It must not arm the dedup slot or surface a toast.
      onColdStartLaunchUrlForTesting("forta://share");

      expect(onInvite).not.toHaveBeenCalled();
      expect(onJoin).not.toHaveBeenCalled();
      expect(onMalformed).not.toHaveBeenCalled();

      // And a real invite arriving on the listener afterwards must route
      // normally — the share URL did not pollute the dedup slot.
      onDeepLinkOpen(`https://forta.chat/invite?ref=${VALID_ADDR}`);
      expect(onInvite).toHaveBeenCalledTimes(1);
    });
  });
});

