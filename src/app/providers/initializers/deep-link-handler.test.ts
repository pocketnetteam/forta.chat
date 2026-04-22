import { describe, it, expect, beforeEach, vi } from "vitest";

// Capacitor App plugin is only used on native; in happy-dom the listener is a
// no-op. Mock it anyway so the module can safely import without pulling the
// actual plugin.
vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
  },
}));

vi.mock("@/shared/lib/platform", () => ({
  isNative: false,
}));

import {
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
});
