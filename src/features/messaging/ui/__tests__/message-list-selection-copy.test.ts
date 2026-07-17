import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression for the "Copy" context-menu action copying the entire message
 * body instead of the user's text selection (forta-bugs #801, #579, WEE-42).
 *
 * When the user long-presses a message and selects a phone number / fragment,
 * tapping Copy should put just that fragment in the clipboard. Previously the
 * handler wrote `message.content` unconditionally, dropping the selection.
 *
 * Source-level assertion mirrors MessageContextMenu-save-action.test.ts —
 * the in-flight context menu setup is not worth mounting just to verify a
 * single switch-case branch.
 */
const getSource = (): string =>
  readFileSync(resolve(__dirname, "../MessageList.vue"), "utf-8");

describe("MessageList — copy action prefers active text selection", () => {
  it("reads the current selection inside the copy branch", () => {
    const source = getSource();
    const fnStart = source.indexOf("const handleContextAction");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = source.indexOf("\n};", fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const fn = source.slice(fnStart, fnEnd);

    // Locate the copy branch and make sure it calls getSelection() before
    // falling back to message.content — otherwise we regress to copying the
    // whole bubble even when the user highlighted "1234567".
    const copyIdx = fn.indexOf('case "copy"');
    expect(copyIdx).toBeGreaterThan(-1);
    const nextCase = fn.indexOf("case ", copyIdx + 1);
    const copyBranch = fn.slice(copyIdx, nextCase === -1 ? undefined : nextCase);

    expect(copyBranch).toMatch(/getSelection\(\)/);
    expect(copyBranch).toMatch(/message\.content/);
    expect(copyBranch).toMatch(/clipboard\.writeText/);
  });

  it("still falls back to message.content when no selection exists", () => {
    const source = getSource();
    const fnStart = source.indexOf("const handleContextAction");
    const fnEnd = source.indexOf("\n};", fnStart);
    const fn = source.slice(fnStart, fnEnd);
    const copyIdx = fn.indexOf('case "copy"');
    const nextCase = fn.indexOf("case ", copyIdx + 1);
    const copyBranch = fn.slice(copyIdx, nextCase === -1 ? undefined : nextCase);

    // The branch must guard for an empty selection (selection.toString() is
    // "" outside the bubble) and fall back to the full message body.
    expect(copyBranch).toMatch(/length\s*>\s*0|\.trim\(\)|\?\s*:|\|\|/);
  });
});
