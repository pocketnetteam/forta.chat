import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * A private key or a mnemonic typed on a phone went through the keyboard's autocorrect:
 * Gboard on a Pixel 9 changed words of a valid 12-word mnemonic and the app answered
 * «Invalid private key or mnemonic» (E2E login on the bench, 2026-09-22), while the same
 * string set through the DOM signed in at once. Credentials must never be corrected,
 * capitalized, suggested or spell-checked — that also keeps them out of the keyboard's
 * dictionary.
 */
const ROOT = resolve(__dirname, "../../../../..");
const INPUTS = [
  "features/auth/ui/login-form/PrivateKeyInput.vue",
  "features/account-switcher/ui/AddAccountModal.vue",
];

describe("credential inputs", () => {
  for (const file of INPUTS) {
    it(`${file} turns keyboard autocorrect off on its credential field`, () => {
      const source = readFileSync(resolve(ROOT, file), "utf-8");
      const textarea = source.slice(source.indexOf("<textarea"), source.indexOf("/>", source.indexOf("<textarea")));
      for (const attr of ['autocomplete="off"', 'autocapitalize="off"', 'autocorrect="off"', 'spellcheck="false"']) {
        expect(textarea, `${file}: ${attr}`).toContain(attr);
      }
    });
  }
});
