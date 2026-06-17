/**
 * Pure derivation of the secondary-button visibility rules in MessageInput.
 *
 * Extracted for WEE-48 / forta-bugs#593, #515 so we can lock the responsive
 * contract without mounting the full SFC. The rules are intentionally tiny;
 * keeping them out of `<script setup>` means a future tweak (e.g. tablet
 * carve-out) is a one-line change with regression coverage in place.
 */

export interface InputLayoutInput {
  /** Tailwind `md` breakpoint — matches the `useMobile()` composable. */
  isMobile: boolean;
  /** A phone held in landscape. Width-based `md` detection reports such
   *  devices as desktop (a landscape phone is wider than 768px), which kept
   *  the secondary-action row pinned open and broke the edit layout (#829).
   *  Treated as mobile-like here. Optional — defaults to false. */
  isLandscapePhone?: boolean;
  /** Current textarea contents — trimmed empty hides primary actions on mobile. */
  text: string;
  /** Whether the host supports the wallet shortcut at all. */
  showDonate: boolean;
}

export interface InputLayoutResult {
  /** Show PKOIN / attach / wallet etc. shortcut row next to the textarea. */
  showSecondaryActions: boolean;
  /** Show the dedicated PKOIN button. Hidden on mobile only while the user
   *  is typing — same rule the other secondary buttons follow — so the
   *  textarea claims the full row mid-message and donate stays one tap away
   *  when the input is idle. */
  showDonateShortcut: boolean;
}

export const deriveInputLayout = (input: InputLayoutInput): InputLayoutResult => {
  const mobileLike = input.isMobile || input.isLandscapePhone === true;
  const showSecondaryActions = !mobileLike || input.text.trim().length === 0;
  const showDonateShortcut = input.showDonate && showSecondaryActions;
  return { showSecondaryActions, showDonateShortcut };
};
