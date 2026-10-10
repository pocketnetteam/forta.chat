/**
 * The bug report text the user is typing, kept for the browser session.
 *
 * The text was lost when the phone was rotated (forta-bugs report; the exact
 * reset path was not found, audit W2B-04). Keeping the draft in sessionStorage
 * brings it back whenever the form opens or remounts, whatever reset it.
 * Storage failures are ignored: the draft is a convenience.
 */
const DRAFT_KEY = "forta:bug-report-draft";

export function saveBugReportDraft(text: string): void {
  try {
    if (text.trim()) window.sessionStorage.setItem(DRAFT_KEY, text);
    else window.sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // storage unavailable
  }
}

export function loadBugReportDraft(): string {
  try {
    return window.sessionStorage.getItem(DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
}

export function clearBugReportDraft(): void {
  try {
    window.sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // storage unavailable
  }
}
