/**
 * Tests for date/time formatting utilities.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { formatDate, formatDuration, formatRelativeTime } from "./format";

const LOCALE_KEY = "forta-chat:locale";

describe("formatDate", () => {
  beforeEach(() => {
    localStorage.removeItem(LOCALE_KEY);
  });
  afterEach(() => {
    localStorage.removeItem(LOCALE_KEY);
  });

  it("returns 'Today' for today's date", () => {
    expect(formatDate(new Date())).toBe("Today");
  });

  it("returns 'Yesterday' for yesterday", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(formatDate(yesterday)).toBe("Yesterday");
  });

  it("returns formatted date for older dates", () => {
    const old = new Date("2023-06-15");
    const result = formatDate(old);
    // Should contain month and day (not "Today" or "Yesterday")
    expect(result).not.toBe("Today");
    expect(result).not.toBe("Yesterday");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns 'Сегодня' in russian locale for today", () => {
    localStorage.setItem(LOCALE_KEY, JSON.stringify("ru"));
    expect(formatDate(new Date())).toBe("Сегодня");
  });

  it("returns 'Вчера' in russian locale for yesterday", () => {
    localStorage.setItem(LOCALE_KEY, JSON.stringify("ru"));
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(formatDate(yesterday)).toBe("Вчера");
  });
});

describe("formatRelativeTime", () => {
  beforeEach(() => {
    localStorage.removeItem(LOCALE_KEY);
  });
  afterEach(() => {
    localStorage.removeItem(LOCALE_KEY);
  });

  it("returns 'Yesterday' in english for yesterday", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(formatRelativeTime(yesterday)).toBe("Yesterday");
  });

  it("returns 'Вчера' in russian locale for yesterday", () => {
    localStorage.setItem(LOCALE_KEY, JSON.stringify("ru"));
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(formatRelativeTime(yesterday)).toBe("Вчера");
  });
});

describe("formatDuration", () => {
  it("formats 0 seconds", () => {
    expect(formatDuration(0)).toBe("0:00");
  });

  it("formats seconds less than a minute", () => {
    expect(formatDuration(45)).toBe("0:45");
  });

  it("formats exact minutes", () => {
    expect(formatDuration(120)).toBe("2:00");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(90)).toBe("1:30");
  });

  it("pads single-digit seconds", () => {
    expect(formatDuration(61)).toBe("1:01");
  });
});
