/**
 * Invite / join deep-link *generation* — the write-side counterpart to
 * `parse-invite-url.ts` (the read-side). They live together on purpose: the
 * link shapes we emit and the shapes we accept must never drift apart.
 *
 * These links MUST carry the target in the URL *path* (`/invite`, `/join`),
 * not in the hash fragment. Android App Links match an incoming URI against
 * the intent-filter `pathPrefix` (`AndroidManifest.xml`), and the fragment is
 * never part of the path: a hash-form link such as
 * `https://forta.chat/#/invite?ref=...` has path `/`, so the OS can't match it
 * to the app and hands it to the browser instead — the regression reported in
 * forta-bugs#1014 (invite opens browser though the app is installed; WEE-104).
 *
 * The original bare-path 404 (forta-bugs#435 / #29; WEE-27) is solved on the
 * static host, not by mangling the link: `public/invite/index.html` and
 * `public/join/index.html` are tiny redirect shims that bounce a browser
 * (recipient without the app, or unverified App Links) to the SPA hash route
 * (`/#/invite?...`), preserving the query string. So one path serves both:
 *   - installed app  → App Link path match → `appUrlOpen` → parse-invite-url
 *   - browser, no app → static shim → hash route → welcome / join screen
 *
 * Native deep-linking also accepts the `forta://` custom scheme as a fallback
 * (see `parse-invite-url.ts`) when App Link verification never took.
 */

import { APP_PUBLIC_URL } from "@/shared/config";

/** Personal invite: opens the welcome screen and pre-fills the inviter's
 *  Bastyon address so accepting creates a 1:1 chat. */
export function buildInviteUrl(address: string): string {
  return `${APP_PUBLIC_URL}/invite?ref=${encodeURIComponent(address)}`;
}

/** Group / room join: opens the welcome screen primed to join `roomId`. */
export function buildJoinUrl(roomId: string): string {
  return `${APP_PUBLIC_URL}/join?room=${encodeURIComponent(roomId)}`;
}
