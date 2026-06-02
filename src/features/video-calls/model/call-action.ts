import type { CallProvider } from "@/shared/lib/local-db";

/**
 * Pure decision logic for the unified "Позвонить" button (WEE-57).
 *
 * Side-effect free so it is trivially unit-testable; the composable
 * (`use-call-launcher.ts`) executes the resolved action. There is no global
 * toggle — having ≥1 configured provider is itself the signal that external
 * methods are in play.
 */

/** One selectable option in the call-method menu. */
export type CallOption =
  | { type: "native" }
  | { type: "external"; provider: CallProvider };

/** The action the launcher should perform for a given tap. */
export type CallAction =
  | { type: "native" }                        // place a Forta WebRTC call
  | { type: "send"; provider: CallProvider }  // send this provider's link, no menu
  | { type: "picker"; options: CallOption[] }; // ask the user

export interface ResolveCallActionInput {
  providers: CallProvider[];
  /** DM (1:1) chats offer the native Forta option; groups show links only. */
  isDm: boolean;
}

/**
 * Build the menu option list. In a DM the native Forta call is offered first
 * (the user keeps the built-in option). In a group only external links are
 * shown — native group calls have vendor reliability issues (WEE-53/WEE-56).
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
 * Opens the menu only when there is an actual choice; performs the single
 * option directly otherwise:
 * - DM, no providers → 1 option (native) → native call (backward compatible).
 * - DM, ≥1 provider → menu [native, …links].
 * - Group, 1 provider → send that link directly (no pointless 1-item menu).
 * - Group, ≥2 providers → menu [links].
 * - Group, no providers → native group call (defensive; the button is hidden
 *   in this case so this path is normally unreachable).
 */
export function resolveCallAction(input: ResolveCallActionInput): CallAction {
  const options = buildPickerOptions(input.providers, input.isDm);

  if (options.length === 0) return { type: "native" };
  if (options.length === 1) {
    const only = options[0];
    return only.type === "native" ? { type: "native" } : { type: "send", provider: only.provider };
  }
  return { type: "picker", options };
}
