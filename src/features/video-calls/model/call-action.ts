import type { CallProvider } from "@/shared/lib/local-db";

/**
 * Pure decision logic for the "Позвонить" button override (WEE-57).
 *
 * Kept side-effect free so it is trivially unit-testable; the composable
 * (`use-call-launcher.ts`) executes the resolved action.
 */

/** One selectable option in the call-method picker. */
export type CallOption =
  | { type: "native" }
  | { type: "external"; provider: CallProvider };

/** The action the launcher should perform for a given tap. */
export type CallAction =
  | { type: "native" }                       // place a Forta WebRTC call
  | { type: "send"; provider: CallProvider }  // send this provider's link, no picker
  | { type: "picker"; options: CallOption[] }; // ask the user

export interface ResolveCallActionInput {
  providers: CallProvider[];
  /** Global "use external instead of native" toggle. */
  useExternal: boolean;
  /** DM (1:1) chats offer the native Forta option in the picker; groups do not. */
  isDm: boolean;
  /** Long-press / explicit "choose method" — always show the picker. */
  forcePicker?: boolean;
}

/**
 * Build the picker option list. In a DM, the native Forta call is offered
 * first (per spec refinement — user keeps the existing option). In a group
 * only external providers are shown (native group calls have vendor
 * reliability issues — WEE-53/WEE-56).
 */
export function buildPickerOptions(providers: CallProvider[], isDm: boolean): CallOption[] {
  return [
    ...(isDm ? [{ type: "native" } as const] : []),
    ...providers.map((provider) => ({ type: "external" as const, provider })),
  ];
}

/**
 * Decide what happens when the user taps the call button.
 *
 * - Toggle off OR no providers → native call (backward compatible, A6).
 * - Exactly one provider → send its link immediately, no friction (A3).
 * - Several providers + a marked default → quick-send the default (A4),
 *   unless `forcePicker` (long-press) overrides.
 * - Several providers, no default (or forced) → open the picker (A4/A4b).
 */
export function resolveCallAction(input: ResolveCallActionInput): CallAction {
  const { providers, useExternal, isDm, forcePicker } = input;

  if (!useExternal || providers.length === 0) {
    return { type: "native" };
  }

  if (!forcePicker && providers.length === 1) {
    return { type: "send", provider: providers[0] };
  }

  if (!forcePicker) {
    const def = providers.find((p) => p.isDefault);
    if (def) return { type: "send", provider: def };
  }

  return { type: "picker", options: buildPickerOptions(providers, isDm) };
}
