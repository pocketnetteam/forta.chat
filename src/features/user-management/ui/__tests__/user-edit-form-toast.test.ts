import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * WEE-25 / forta-bugs#281 — profile Save must produce user-visible feedback.
 *
 * The inline `saveSuccess` button-state toggle is easy to miss on long forms
 * or when the user has scrolled away. This test pins the toast wiring so a
 * future refactor cannot silently drop it.
 *
 * Source-level assertion mirrors user-edit-form-source.test.ts so we don't
 * have to mount the full auth + locale + user store tree for one branch.
 */
const getSource = () =>
  readFileSync(resolve(__dirname, "../UserEditForm.vue"), "utf-8");

describe("UserEditForm — toast feedback on save (WEE-25)", () => {
  it("imports useToast from shared/lib", () => {
    const src = getSource();
    expect(src).toMatch(/import\s*\{\s*useToast\s*\}\s*from\s*"@\/shared\/lib\/use-toast"/);
  });

  it("destructures toast from useToast at component setup", () => {
    const src = getSource();
    expect(src).toMatch(/const\s*\{\s*toast\s*\}\s*=\s*useToast\(\)/);
  });

  it("handleSave surfaces a success toast after editUserData succeeds", () => {
    const src = getSource();
    const start = src.indexOf("handleSave = async");
    expect(start).toBeGreaterThan(-1);
    const fn = src.slice(start, start + 3000);
    // Success branch must call toast(t('profile.saved'), 'success').
    expect(fn).toMatch(/toast\(\s*t\(\s*["']profile\.saved["']\s*\)\s*,\s*["']success["']\s*\)/);
  });

  it("handleSave surfaces an error toast on failure (catch + structured envelope)", () => {
    const src = getSource();
    const start = src.indexOf("handleSave = async");
    expect(start).toBeGreaterThan(-1);
    const fn = src.slice(start, start + 3000);
    // At least one error-path toast for the surfaced failure mode.
    expect(fn).toMatch(/toast\(\s*t\(\s*["']profile\.saveFailed["']\s*\)\s*,\s*["']error["']\s*\)/);
  });
});
