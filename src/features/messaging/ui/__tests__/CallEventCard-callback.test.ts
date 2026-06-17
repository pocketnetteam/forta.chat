import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * WEE-49 / forta-bugs#754: tapping a call-event card in the timeline
 * triggers a callback to the same peer using the same call type.
 *
 * WEE-63 / forta-bugs#923: that callback now routes through the provider-aware
 * launcher (`useCallLauncher`) instead of calling `startCall` directly, so a
 * chat with configured external meeting links (WEE-57) surfaces a picker.
 *
 * Source-level assertion in the same style as message-content-link-click —
 * mounting CallEventCard requires Pinia + the full call/messaging stack,
 * which is far more brittle than the click-handler contract this regression
 * actually cares about.
 */
const getSource = (): string =>
  readFileSync(resolve(__dirname, "../CallEventCard.vue"), "utf-8");

describe("CallEventCard — callback handler", () => {
  it("routes the call-back through the provider-aware launcher (WEE-63)", () => {
    const source = getSource();
    expect(source).toMatch(/from\s+['"]@\/features\/video-calls['"]/);
    expect(source).toMatch(/\buseCallLauncher\b/);
    // The launcher instance must be created in component setup (per-component),
    // not at module scope, so virtual-scroller siblings don't share picker state.
    expect(source).toMatch(/const\s+callLauncher\s*=\s*useCallLauncher\(\)/);
  });

  it("imports the call store so it can disable the card during an active call", () => {
    const source = getSource();
    expect(source).toMatch(/from\s+['"]@\/entities\/call['"]/);
    expect(source).toMatch(/\buseCallStore\b/);
  });

  it("declares a handleCallback handler that launches with roomId + callType + isDm", () => {
    const source = getSource();
    expect(source).toMatch(/const\s+handleCallback\s*=/);
    // Must use the message's roomId + the original call type — defaulting
    // back to "voice" when callInfo is missing so an old-format call event
    // still produces a sensible voice call.
    expect(source).toMatch(/callInfo\?\.callType\s*\?\?\s*['"]voice['"]/);
    expect(source).toMatch(/callLauncher\.launch\(\s*props\.message\.roomId\s*,/);
    // DM vs group is computed so groups with providers get a picker.
    expect(source).toMatch(/isGroup/);
  });

  it("disables the click when another call is already active", () => {
    const source = getSource();
    // Guard inside the handler so a programmatic invocation is also blocked.
    expect(source).toMatch(/if\s*\(\s*!isClickable\.value\s*\)\s*return/);
    // And reflected in the DOM via `:disabled` so the user sees the affordance.
    expect(source).toMatch(/:disabled=['"]!isClickable['"]/);
    expect(source).toMatch(/isClickable[\s\S]*?!callStore\.isInCall/);
  });

  it("renders the provider picker bound to the launcher state", () => {
    const source = getSource();
    expect(source).toMatch(/<CallProviderPicker/);
    expect(source).toMatch(/:show=['"]callLauncher\.pickerOpen\.value['"]/);
    expect(source).toMatch(/@pick=['"]callLauncher\.pick['"]/);
  });

  it("renders as a <button> so keyboard/AT users get the click affordance", () => {
    const source = getSource();
    // Wrapper element must be a <button>, not a <div> — pressing Enter on a
    // div would not fire @click, which would re-introduce #754 for keyboard-
    // only Android TalkBack users.
    expect(source).toMatch(/<button[\s\S]*?@click=['"]handleCallback/);
    expect(source).toMatch(/type=['"]button['"]/);
  });
});
