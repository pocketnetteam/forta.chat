import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * UX regression for AES-SIV ciphertext failure (issues #290–300, #312).
 *
 * When a file's decryption fails (errorKind === "crypto"), the user must NOT
 * see "AES-SIV: ciphertext verification failure!" in red. Instead they see
 * a friendly message in their language, a retry button, and an explicit
 * "Report a problem" affordance for the rare case they want to file a bug
 * (auto-bug-report is blacklisted for crypto errors).
 *
 * Mounting MessageBubble requires ~10 mocks (chatStore, themeStore, gestures,
 * virtual scroll, etc.) which is brittle and out of proportion with the
 * one-line UX wiring we want to verify. A source-level assertion is the right
 * tool here.
 */
const getSource = (): string =>
  readFileSync(
    resolve(__dirname, "../MessageBubble.vue"),
    "utf-8",
  );

describe("MessageBubble — friendly UX for crypto decryption errors", () => {
  it("renders chat.decryptError.* keys when fileState.errorKind === 'crypto'", () => {
    const source = getSource();
    // The crypto branch must reference the friendly i18n keys, not the raw
    // ciphertext error message.
    expect(source).toMatch(/fileState\.errorKind\s*===\s*['"]crypto['"]/);
    expect(source).toContain("chat.decryptError.title");
    expect(source).toContain("chat.decryptError.askResend");
    expect(source).toContain("chat.decryptError.retry");
    expect(source).toContain("chat.decryptError.reportProblem");
  });

  it("wires retryDownload to clear the crypto errorKind so download() can run again", () => {
    const source = getSource();
    // retryDownload must reset errorKind alongside error — otherwise the
    // friendly UI sticks even after a successful retry.
    const fnStart = source.indexOf("const retryDownload");
    const fnEnd = source.indexOf("};", fnStart);
    expect(fnStart).toBeGreaterThan(-1);
    const fn = source.slice(fnStart, fnEnd);
    expect(fn).toMatch(/state\.error\s*=\s*null/);
    expect(fn).toMatch(/state\.errorKind\s*=\s*null/);
  });

  it("uses chat.decryptError.askSelf for own messages and askResend for others", () => {
    const source = getSource();
    // The subtitle copy must branch on isOwn so a self-sent file does not say
    // "ask the sender to resend" (the user IS the sender).
    expect(source).toMatch(/isOwn\s*\?\s*t\(['"]chat\.decryptError\.askSelf['"]\)\s*:\s*t\(['"]chat\.decryptError\.askResend['"]\)/);
  });

  it("renders the new buttons with type=\"button\" to prevent accidental form submission", () => {
    const source = getSource();
    // Both retry and reportDownloadProblem buttons live inside elements that
    // could be ancestors of a form one day; explicit type guards against the
    // implicit 'submit' default.
    const start = source.indexOf("chat.decryptError.title");
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, start + 1500);
    // Two type="button" attributes adjacent to the new buttons.
    const matches = block.match(/<button[^>]*type="button"/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("provides reportDownloadProblem as a manual escape hatch (auto-report is blacklisted)", () => {
    const source = getSource();
    expect(source).toContain("reportDownloadProblem");
    // Must call useBugReport().open with the file-download context.
    const fnStart = source.indexOf("const reportDownloadProblem");
    const fnEnd = source.indexOf("};", fnStart);
    const fn = source.slice(fnStart, fnEnd);
    expect(fn).toContain("useBugReport()");
    expect(fn).toContain("bugReport.ctx.fileDownload");
  });
});
