/**
 * Native deep-link delivery for Forta Chat.
 *
 * Android App Links / custom scheme URLs arrive through Capacitor's
 * `App.appUrlOpen` event. On a cold start the event fires *before* Vue, the
 * router, or Matrix are ready — so we buffer URLs until `registerDeepLinkHandlers`
 * is called from the app bootstrap path.
 *
 * Usage:
 *   - Call `setupDeepLinkHandler()` synchronously in `main.ts`, before any
 *     await. This just wires up the Capacitor listener.
 *   - Call `registerDeepLinkHandlers({ onInvite, onJoin })` once the router
 *     (and, if needed, auth/Matrix) can act on a deep link. Any URLs that
 *     arrived while we were still booting are delivered immediately.
 */

import { parseDeepLink, type InviteTarget, type JoinTarget } from "@/shared/lib/parse-invite-url";
import { isNative } from "@/shared/lib/platform";

/** A URL "looks like ours" if it targets a forta host or uses the custom
 *  scheme — i.e. something the user clearly expected to open the app, but
 *  may have mangled (bad param, missing ref). We only surface the
 *  "invalid link" toast for these, not for every unrelated URL. */
function looksLikeFortaUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol === "forta:") return true;
    return url.hostname === "forta.chat" || url.hostname === "www.forta.chat";
  } catch {
    return false;
  }
}

/** Internal-use forta:// URLs that aren't user-visible deep links. Today
 *  the only one is `forta://share`, posted by the iOS Share Extension to
 *  bring the host app to the foreground after writing the share payload to
 *  the App Group. The Capgo share-target plugin reads the payload natively
 *  on `appUrlOpen` — JS only needs to know not to toast "invalid link".
 *  Match on host, ignoring trailing slash / query: `forta://share`,
 *  `forta://share/`, `forta://share?foo=1` all qualify. */
function isInternalSystemUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "forta:") return false;
    return url.hostname === "share";
  } catch {
    return false;
  }
}

export interface DeepLinkHandlers {
  onInvite: (target: InviteTarget) => void;
  onJoin: (target: JoinTarget) => void;
  /** Fires when a Forta-scheme URL arrived but couldn't be parsed — e.g. a
   *  malformed `?ref=` or a path claimed by the intent-filter but unknown to
   *  the app. Optional: callers that don't care can leave it unset. */
  onMalformed?: (rawUrl: string) => void;
}

/** Hard cap on the cold-start buffer — a misbehaving ROM that loops intents
 *  should not leak memory. 16 is well above any realistic cold-start storm
 *  (usually 0–1 URLs) and bounds the blast radius. */
const MAX_PENDING_URLS = 16;

let pendingUrls: string[] = [];
let handlers: DeepLinkHandlers | null = null;
let listenerRegistered = false;

function dispatch(url: string, active: DeepLinkHandlers): void {
  // forta://share and friends are system signals from the iOS Share
  // Extension — the share payload is delivered out-of-band via the
  // CapacitorShareTarget plugin reading the App Group UserDefaults. We
  // must not toast "invalid invite link" for them.
  if (isInternalSystemUrl(url)) return;

  const target = parseDeepLink(url);
  try {
    if (target) {
      if (target.kind === "invite") active.onInvite({ address: target.address });
      else active.onJoin({ roomId: target.roomId });
    } else if (looksLikeFortaUrl(url)) {
      // Forta URL that our parsers couldn't decode — notify the UI so the
      // user sees "invalid invite link" instead of silent nothing.
      active.onMalformed?.(url);
    }
    // URLs that aren't even forta-shaped (e.g. https://google.com) drop silently.
  } catch (e) {
    console.error("[deep-link-handler] handler threw:", e);
  }
}

function drainBuffer(active: DeepLinkHandlers): void {
  while (pendingUrls.length > 0) {
    const url = pendingUrls.shift();
    if (url) dispatch(url, active);
  }
}

/** Called by the Capacitor listener (or tests) every time a new URL opens the app. */
export function onDeepLinkOpen(url: string): void {
  // Internal system URLs (forta://share) carry no payload of their own —
  // the side effect (waking the host app so the Capgo share-target plugin
  // can flush its UserDefaults) is what matters. Drop them before they
  // can occupy a slot in the cold-start buffer.
  if (isInternalSystemUrl(url)) return;

  if (!handlers) {
    if (pendingUrls.length >= MAX_PENDING_URLS) {
      console.warn("[deep-link-handler] buffer full, dropping URL");
      return;
    }
    pendingUrls.push(url);
    return;
  }
  dispatch(url, handlers);
}

/** Wire up the Capacitor listener. Safe to call once per app lifetime;
 *  subsequent calls are no-ops. */
export function setupDeepLinkHandler(): void {
  if (listenerRegistered) return;
  listenerRegistered = true;

  if (!isNative) return;

  // Lazy-import so the web bundle doesn't carry the native plugin's runtime.
  import("@capacitor/app")
    .then(({ App }) => {
      App.addListener("appUrlOpen", (event: { url: string }) => {
        onDeepLinkOpen(event.url);
      });
    })
    .catch((e) => {
      console.warn("[deep-link-handler] failed to wire appUrlOpen listener:", e);
    });
}

/** Install the app's actual invite/join handlers and flush the buffer.
 *  Intended to be called exactly once (from `App.vue` onMounted). A second
 *  call — e.g. a dev hot-reload or an accidental double-mount — replaces the
 *  callbacks with a warning. In production this shouldn't happen. */
export function registerDeepLinkHandlers(next: DeepLinkHandlers): void {
  if (handlers) {
    console.warn("[deep-link-handler] handlers replaced (unexpected outside HMR)");
  }
  handlers = next;
  drainBuffer(next);
}

export function resetDeepLinkHandlerForTesting(): void {
  pendingUrls = [];
  handlers = null;
  listenerRegistered = false;
}
