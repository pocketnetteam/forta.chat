import { describe, it, expect, beforeEach, vi } from "vitest";

// Capacitor App plugin is native-only; mock so the handler module imports
// cleanly in happy-dom (mirrors deep-link-handler.test.ts).
vi.mock("@capacitor/app", () => ({
  App: { addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }) },
}));
vi.mock("@/shared/lib/platform", () => ({ isNative: false }));

import {
  onDeepLinkOpen,
  registerDeepLinkHandlers,
  resetDeepLinkHandlerForTesting,
} from "../deep-link-handler";
import { buildInviteUrl, buildJoinUrl } from "@/shared/lib/invite-link";

/**
 * WEE-104 regression — invite/join deep-links on 1.10.44.
 *
 * Root cause: WEE-27 switched the generators to the hash form
 * `https://forta.chat/#/invite?ref=...`, whose URL *path* is "/". Android App
 * Links match the intent-filter `pathPrefix` against the path (the fragment is
 * invisible to the OS), so the installed app was never offered the URL and it
 * opened in the browser instead (forta-bugs#1014).
 *
 * These tests lock the *generated* link to two invariants at once:
 *   1. the target rides in the URL path, so the App-Link intent-filter matches;
 *   2. the same link still dispatches through the native handler to onInvite/
 *      onJoin — so generation and delivery can never silently drift apart again.
 */

const ADDR = "PMyAddress1234567890ABCDEFGHIJKLMN";
const ROOM_ID = "!abcdef123:matrix.pocketnet.app";

describe("WEE-104 invite/join deep-link regression", () => {
  beforeEach(() => {
    resetDeepLinkHandlerForTesting();
  });

  it("generated invite link carries the target in the path (App-Link matchable)", () => {
    const url = new URL(buildInviteUrl(ADDR));
    // The intent-filter declares pathPrefix="/invite"; only a real path matches.
    expect(url.pathname.startsWith("/invite")).toBe(true);
    expect(url.hash).toBe("");
  });

  it("generated join link carries the target in the path (App-Link matchable)", () => {
    const url = new URL(buildJoinUrl(ROOM_ID));
    expect(url.pathname.startsWith("/join")).toBe(true);
    expect(url.hash).toBe("");
  });

  it("generated invite link dispatches to onInvite when delivered natively", () => {
    const onInvite = vi.fn();
    const onJoin = vi.fn();
    registerDeepLinkHandlers({ onInvite, onJoin });

    onDeepLinkOpen(buildInviteUrl(ADDR));

    expect(onInvite).toHaveBeenCalledWith({ address: ADDR });
    expect(onJoin).not.toHaveBeenCalled();
  });

  it("generated join link dispatches to onJoin when delivered natively", () => {
    const onInvite = vi.fn();
    const onJoin = vi.fn();
    registerDeepLinkHandlers({ onInvite, onJoin });

    onDeepLinkOpen(buildJoinUrl(ROOM_ID));

    expect(onJoin).toHaveBeenCalledWith({ roomId: ROOM_ID });
    expect(onInvite).not.toHaveBeenCalled();
  });

  it("survives cold-start buffering with the generated link", () => {
    const onInvite = vi.fn();
    const onJoin = vi.fn();

    // URL arrives before the router is ready (cold start), then drains.
    onDeepLinkOpen(buildInviteUrl(ADDR));
    expect(onInvite).not.toHaveBeenCalled();

    registerDeepLinkHandlers({ onInvite, onJoin });
    expect(onInvite).toHaveBeenCalledWith({ address: ADDR });
  });
});
