/**
 * Pure helpers that compute panel placement for `EmojiPicker.vue`.
 *
 * Extracted as standalone functions so the layout logic can be unit-tested
 * without spinning up a Vue tree — happy-dom drops CSS values that contain
 * `var()` and `min(...)`, which makes asserting against `el.style.bottom`
 * unreliable for the rendered panel.
 */

export const PICKER_PAD = 8;
export const PICKER_W = 370;
export const PICKER_H = 420;
/** Breathing room between the picker and the tap point, so the panel never
 *  sits directly on top of the long-pressed message (WEE-34 / forta-bugs#791). */
export const PICKER_GAP = 12;

export interface PickerStyle {
  left: string;
  top: string;
  bottom: string;
  width: string;
  height: string;
  borderRadius: string;
  // Allow CSS custom properties so the object satisfies Vue's StyleValue.
  [cssVar: `--${string}`]: string;
}

export interface PickerLayoutInput {
  isMobile: boolean;
  mode: "input" | "reaction";
  x: number;
  y: number;
  vw: number;
  vh: number;
}

/** Mobile (input mode): dock above MessageInput via the height it publishes
 *  through `--message-input-height`. */
export function computeMobileInputPanelStyle(): PickerStyle {
  return {
    left: "0px",
    top: "auto",
    bottom: "var(--message-input-height, 0px)",
    width: "100%",
    height: "min(45dvh, 360px)",
    borderRadius: "16px 16px 0 0",
  };
}

/** Mobile (reaction mode): place the picker clear of the long-pressed message.
 *  forta-bugs#791 — the panel used to anchor its bottom edge exactly at the tap
 *  point, covering the upper half of the pressed bubble. Now we leave a gap and
 *  prefer above → below → whichever side has more room, so the picker adapts to
 *  the viewport and avoids the tap point whenever a side fits. On very short
 *  viewports the panel is up to half the height, so a mid-screen tap can't be
 *  fully cleared — the final clamp keeps it on-screen as a best effort. */
export function computeMobileReactionPanelStyle(y: number, vh: number): PickerStyle {
  const panelH = Math.min(360, vh * 0.5);
  const spaceAbove = y - PICKER_PAD;
  const spaceBelow = vh - y - PICKER_PAD;

  let top: number;
  if (spaceAbove >= panelH + PICKER_GAP) {
    // Sit fully above the tap point with a gap.
    top = y - PICKER_GAP - panelH;
  } else if (spaceBelow >= panelH + PICKER_GAP) {
    // Drop below the tap point, again leaving a gap.
    top = y + PICKER_GAP;
  } else {
    // Neither side fully fits: anchor to whichever side has more room.
    top = spaceAbove >= spaceBelow ? PICKER_PAD : vh - panelH - PICKER_PAD;
  }

  // Keep the panel inside the viewport regardless of the branch taken.
  top = Math.max(PICKER_PAD, Math.min(top, vh - panelH - PICKER_PAD));

  return {
    left: "0px",
    top: `${top}px`,
    bottom: "auto",
    width: "100%",
    height: `${panelH}px`,
    borderRadius: "16px",
  };
}

/** Desktop / tablet: floating panel anchored near (x, y), clamped to viewport. */
export function computeAnchoredPanelStyle(x: number, y: number, vw: number, vh: number): PickerStyle {
  const panelW = Math.min(PICKER_W, vw - PICKER_PAD * 2);
  const panelH = Math.min(PICKER_H, vh - PICKER_PAD * 2);

  const left = Math.max(PICKER_PAD, Math.min(x, vw - panelW - PICKER_PAD));

  const spaceAbove = y - PICKER_PAD;
  const spaceBelow = vh - y - PICKER_PAD;

  let top: number;
  if (spaceAbove >= panelH) {
    top = y - panelH;
  } else if (spaceBelow >= panelH) {
    top = y;
  } else if (spaceAbove >= spaceBelow) {
    top = PICKER_PAD;
  } else {
    top = vh - panelH - PICKER_PAD;
  }

  top = Math.max(PICKER_PAD, Math.min(top, vh - panelH - PICKER_PAD));

  return {
    left: `${left}px`,
    top: `${top}px`,
    bottom: "auto",
    width: `${panelW}px`,
    height: `${panelH}px`,
    borderRadius: "16px",
  };
}

export function computePanelStyle(input: PickerLayoutInput): PickerStyle {
  const { isMobile, mode, x, y, vw, vh } = input;
  if (isMobile && mode === "input") return computeMobileInputPanelStyle();
  if (isMobile && mode === "reaction") return computeMobileReactionPanelStyle(y, vh);
  return computeAnchoredPanelStyle(x, y, vw, vh);
}
