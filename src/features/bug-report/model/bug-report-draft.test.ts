// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { clearBugReportDraft, loadBugReportDraft, saveBugReportDraft } from "./bug-report-draft";

/** Audit W2B-04: the bug report text was lost when the phone was rotated. */
describe("bug report draft", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });

  it("keeps the text until the report is sent", () => {
    saveBugReportDraft("the call dropped after 30 s");
    expect(loadBugReportDraft()).toBe("the call dropped after 30 s");
    clearBugReportDraft();
    expect(loadBugReportDraft()).toBe("");
  });

  it("drops an emptied draft", () => {
    saveBugReportDraft("x");
    saveBugReportDraft("   ");
    expect(loadBugReportDraft()).toBe("");
  });

  it("never throws when storage is unavailable", () => {
    vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(window.sessionStorage, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(() => saveBugReportDraft("text")).not.toThrow();
    expect(loadBugReportDraft()).toBe("");
  });

  it("is what the report form restores and clears", () => {
    const modal = readFileSync(resolve(__dirname, "../ui/BugReportModal.vue"), "utf-8");
    expect(modal).toContain("description.value = prefilled || loadBugReportDraft();");
    // A prefilled report (an error, a context) is not the user's draft and must not replace it.
    expect(modal).toContain("isPrefilled.value = prefilled.length > 0;");
    expect(modal).toContain("if (!sent.value && !isPrefilled.value) saveBugReportDraft(text);");
    expect(modal).toMatch(/sent\.value = true;\s*clearBugReportDraft\(\);/);
  });
});
