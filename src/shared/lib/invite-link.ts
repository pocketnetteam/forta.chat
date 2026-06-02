/**
 * Invite / join deep-link *generation* — the write-side counterpart to
 * `parse-invite-url.ts` (the read-side). They live together on purpose: the
 * link shapes we emit and the shapes we accept must never drift apart.
 *
 * Forta's SPA uses hash routing (`createWebHashHistory`). A bare-path link
 * such as `https://forta.chat/join?room=...` has no corresponding file on the
 * static host, so tapping it in a browser — a recipient without the app, or a
 * device where Android App Link verification never took — returns a 404. That
 * is the onboarding blocker reported in forta-bugs#435 / #29 (WEE-27).
 *
 * Emitting the hash form `https://forta.chat/#/join?room=...` always resolves
 * through `index.html` + the client-side router, so the link works everywhere
 * the recipient lands. Native deep-linking is unaffected: legacy bare-path
 * links and the `forta://` custom scheme are still accepted by
 * `parse-invite-url.ts` when delivered through Capacitor's `appUrlOpen`.
 */

import { APP_PUBLIC_URL } from "@/shared/config";

/** Personal invite: opens the welcome screen and pre-fills the inviter's
 *  Bastyon address so accepting creates a 1:1 chat. */
export function buildInviteUrl(address: string): string {
  return `${APP_PUBLIC_URL}/#/invite?ref=${encodeURIComponent(address)}`;
}

/** Group / room join: opens the welcome screen primed to join `roomId`. */
export function buildJoinUrl(roomId: string): string {
  return `${APP_PUBLIC_URL}/#/join?room=${encodeURIComponent(roomId)}`;
}
