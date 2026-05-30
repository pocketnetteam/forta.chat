import { describe, it, expect } from "vitest";
import { en } from "./locales/en";
import { ru } from "./locales/ru";

/**
 * Regression: WEE-40 surfaced a literal "message.retrySend" string in the
 * UI because the key did not exist in any locale and the second arg to t()
 * was a string instead of a params object. The fix swapped the call site to
 * `message.tapToRetry`; these tests pin that ru/en both define the keys the
 * retry indicator actually uses, so a future renaming doesn't silently
 * regress the bubble back to a raw key on screen.
 */
describe("i18n retry keys (WEE-40)", () => {
  it("defines message.tapToRetry in both locales", () => {
    expect(typeof en["message.tapToRetry"]).toBe("string");
    expect(en["message.tapToRetry"].length).toBeGreaterThan(0);
    expect(typeof ru["message.tapToRetry"]).toBe("string");
    expect(ru["message.tapToRetry"].length).toBeGreaterThan(0);
  });

  it("defines message.retry in both locales (used by media-bubble overlay)", () => {
    expect(typeof en["message.retry"]).toBe("string");
    expect(en["message.retry"].length).toBeGreaterThan(0);
    expect(typeof ru["message.retry"]).toBe("string");
    expect(ru["message.retry"].length).toBeGreaterThan(0);
  });

  it("does not ship the broken 'message.retrySend' key (would mean it's still referenced)", () => {
    // Sanity check — if a future commit accidentally re-introduces this key,
    // the test still passes (we only check current absence), but a referencing
    // call site would fail TypeScript's TranslationKey narrowing. The test
    // documents intent: the key was a typo and should stay deleted.
    expect((en as Record<string, string>)["message.retrySend"]).toBeUndefined();
    expect((ru as Record<string, string>)["message.retrySend"]).toBeUndefined();
  });
});
