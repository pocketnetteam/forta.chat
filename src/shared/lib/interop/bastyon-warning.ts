/**
 * Decision logic for the dual-install warning (WEE-35 Task 5 / forta-bugs
 * #81, #417, #418, #893).
 *
 * Forta and Bastyon are separate Android apps sharing one Bastyon identity,
 * Matrix backend and FCM project. Running both causes duplicate call rings,
 * duplicate incoming-call notification settings and user confusion. We can't
 * silently enumerate installed packages without a native plugin, so detection
 * leans on a real available signal: a login that finds an *existing* blockchain
 * account which lacks Forta's 12 encryption keys was almost certainly
 * registered elsewhere — i.e. via Bastyon. See [[key-republish]].
 */

export interface BastyonWarningInput {
  /**
   * Heuristic from the auth flow: the account already exists on-chain but has
   * no Forta-published encryption keys → registered outside Forta (Bastyon).
   */
  likelyBastyonUser: boolean;
  /** The user dismissed the warning before (persisted). */
  dismissed: boolean;
  /** Both apps can only coexist on native Android — gate to that platform. */
  isNativeAndroid: boolean;
}

/**
 * Whether to surface the dual-install warning. Pure so the gating logic is
 * unit-testable without a store or platform.
 */
export function shouldShowBastyonWarning(input: BastyonWarningInput): boolean {
  return input.isNativeAndroid && input.likelyBastyonUser && !input.dismissed;
}
