import { describe, it, expect } from "vitest";
import { formatDate, formatRelativeTime } from "@/shared/lib/format";

/**
 * Regression (WEE-67 / forta-bugs#903): relative date labels must be
 * localized and recompute when the active locale changes. Previously
 * formatDate/formatRelativeTime read the locale once from localStorage
 * via tRaw() and never reacted to in-session language switches.
 */
describe("format date localization (WEE-67)", () => {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  it("formatDate('today', 'ru') returns 'Сегодня'", () => {
    expect(formatDate(today, "ru")).toBe("Сегодня");
  });

  it("formatDate('today', 'en') returns 'Today'", () => {
    expect(formatDate(today, "en")).toBe("Today");
  });

  it("formatDate('yesterday', 'ru') returns 'Вчера'", () => {
    expect(formatDate(yesterday, "ru")).toBe("Вчера");
  });

  it("recomputes label when locale switches ru -> en", () => {
    const ruLabel = formatDate(today, "ru");
    const enLabel = formatDate(today, "en");
    expect(ruLabel).toBe("Сегодня");
    expect(enLabel).toBe("Today");
    expect(ruLabel).not.toBe(enLabel);
  });

  it("formatRelativeTime('yesterday', 'ru') returns 'Вчера'", () => {
    expect(formatRelativeTime(yesterday, "ru")).toBe("Вчера");
  });

  it("formatRelativeTime('yesterday', 'en') returns 'Yesterday'", () => {
    expect(formatRelativeTime(yesterday, "en")).toBe("Yesterday");
  });

  it("falls back gracefully when no locale is passed (non-Vue contexts)", () => {
    // Must still return a non-empty string (reads localStorage via tRaw).
    expect(formatDate(today)).toBeTruthy();
    expect(formatRelativeTime(yesterday)).toBeTruthy();
  });
});
