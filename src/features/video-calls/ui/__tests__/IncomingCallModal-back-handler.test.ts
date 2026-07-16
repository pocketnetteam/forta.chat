import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * WEE-63 / forta-bugs#759 — Android Back on the incoming-call ringer must
 * reject the call, not minimize the app.
 *
 * The active CallWindow registers a priority-100 back handler that returns
 * false while the call is still in the `incoming` state (CallWindow only
 * shows once ringing/connecting/connected). Without a handler on the incoming
 * modal itself, Back falls through to App.minimizeApp(). This regression
 * asserts the modal registers its own handler that rejects when visible and
 * passes through (returns false) otherwise.
 *
 * Source-level assertion: mounting IncomingCallModal needs Pinia + the call
 * service stack; the back-handler contract is what this regression cares about.
 */
const getSource = (): string =>
  readFileSync(resolve(__dirname, "../IncomingCallModal.vue"), "utf-8");

describe("IncomingCallModal — Android Back handler", () => {
  it("imports and registers the shared Android back handler", () => {
    const source = getSource();
    expect(source).toMatch(/useAndroidBackHandler/);
    expect(source).toMatch(
      /from\s+['"]@\/shared\/lib\/composables\/use-android-back-handler['"]/,
    );
  });

  it("registers at priority 100 (same tier as the active call window)", () => {
    const source = getSource();
    expect(source).toMatch(
      /useAndroidBackHandler\(\s*['"]incoming-call-modal['"]\s*,\s*100\s*,/,
    );
  });

  it("rejects the call when visible and passes through otherwise", () => {
    const source = getSource();
    // Pass-through when hidden so the handler chain reaches lower-priority
    // handlers / minimizeApp.
    expect(source).toMatch(/if\s*\(\s*!show\.value\s*\)\s*return\s+false/);
    // Reject + consume the event when the modal is up.
    expect(source).toMatch(/onReject\(\)/);
  });
});
