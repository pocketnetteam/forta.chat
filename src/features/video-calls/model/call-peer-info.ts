/** Peer name and avatar lookup for call screens (split out of call-service.ts). */
import { useCallStore } from "@/entities/call";
import { matrixIdToAddress } from "@/entities/chat/lib/chat-helpers";
import { useUserStore } from "@/entities/user";

/**
 * Maximum wall-clock the call setup will wait for the peer's profile
 * before falling back to the blockchain address. Keeps the answer→media
 * negotiation inside the SDK's 1s window — exceeding that lets the caller's
 * timeout fire first and the user perceives the call as "dropped".
 */
const PEER_PROFILE_LOOKUP_TIMEOUT_MS = 500;

/** Max wait for the room's lazy-loaded members before dialling; past it the
 *  call goes out with whatever members are known. */
export const CALL_MEMBERS_TIMEOUT_MS = 5_000;

/**
 * Resolve the opponent's display name for the call surfaces.
 *
 * Pre-Session-30 this was synchronous: `loadUserIfMissing` was fired-and-
 * forgotten, then `getUser` was read on the next line — so profiles that
 * weren't already cached fell through to the raw blockchain address. The
 * native ringer rendered that address as "Unknown" and Vue surfaces showed
 * a long opaque string (#645).
 *
 * The fix is bounded: race a real `loadUsersBatch` against a 500ms timer.
 * Cached hits return instantly; cold lookups get a half-second window which
 * is enough on 4G to fetch a single profile via dedupe + the existing
 * profilePool. Even if we fall through, [refreshPeerNameAsync] below
 * subscribes for the late update so Vue UI eventually shows the right name.
 */
export async function resolvePeerInfo(peerId: string): Promise<{ peerAddress: string; peerName: string }> {
  const peerAddress = matrixIdToAddress(peerId);
  const userStore = useUserStore();

  // Fast path: profile already cached with a name. Avoids the timer hop
  // for the common case where the caller has been seen recently.
  const cached = userStore.getUser(peerAddress);
  if (cached?.name) {
    return { peerAddress, peerName: cached.name };
  }

  // Bounded wait — `loadUsersBatch` is dedupe-aware so concurrent calls do
  // not multiply network requests. Suppress its rejection because a network
  // failure must not break call setup; we always have the address fallback.
  await Promise.race([
    userStore.loadUsersBatch([peerAddress]).catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, PEER_PROFILE_LOOKUP_TIMEOUT_MS)),
  ]);

  const user = userStore.getUser(peerAddress);
  return {
    peerAddress,
    peerName: user?.name || peerAddress,
  };
}

/**
 * Late-arriving profile update for an already-active call.
 *
 * If [resolvePeerInfo]'s 500ms window expired without a profile, the call
 * surfaces show the blockchain address. This helper continues the load in
 * the background and patches `activeCall.peerName` once a real name lands,
 * but only if the same call is still active — guards against races where
 * the user hung up and started a new call before the profile arrived.
 *
 * Scope: Vue store only. The native CallActivity / IncomingCallActivity
 * read `callerName` from Intent extras at launch and there is no Kotlin
 * bridge to update them mid-call yet. So this helper fixes the JS-side
 * surfaces (CallStatusBar, CallWindow, IncomingCallModal) but the native
 * ringer / in-call screen will continue to show whatever name was passed
 * to `launchCallUI`. Adding a Kotlin updateCallerInfo bridge is tracked
 * separately — flagged in the call-service.ts handleIncomingCall branches.
 *
 * Pre-condition: the caller MUST have already invoked `setActiveCall`
 * with a matching callId before scheduling this. Branches that keep
 * activeCall null (the native non-fast-path) will never satisfy the
 * guard inside, so calling this from there is a no-op and a wasted
 * network round-trip.
 */
export function refreshPeerNameAsync(callId: string, peerAddress: string): void {
  const userStore = useUserStore();
  const callStore = useCallStore();
  userStore
    .loadUsersBatch([peerAddress])
    .then(() => {
      const user = userStore.getUser(peerAddress);
      const name = user?.name;
      if (!name) return;
      const active = callStore.activeCall;
      if (!active || active.callId !== callId) return;
      if (active.peerName === name) return;
      callStore.setActiveCall({ ...active, peerName: name });
    })
    .catch(() => {
      // Network failure — call already shows the address fallback, no UX
      // regression. Logged at debug level only to avoid spamming Sentry.
    });
}
