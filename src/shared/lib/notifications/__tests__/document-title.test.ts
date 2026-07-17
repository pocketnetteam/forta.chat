import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { formatAppDocumentTitle, applyAppDocumentTitle } from "../document-title";

describe("formatAppDocumentTitle", () => {
  it("returns bare app name when unread is 0", () => {
    expect(formatAppDocumentTitle(0)).toBe("Forta Chat");
  });

  it("returns bare app name when unread is negative", () => {
    expect(formatAppDocumentTitle(-1, "App")).toBe("App");
  });

  it("prefixes positive unread count", () => {
    expect(formatAppDocumentTitle(5)).toBe("(5) Forta Chat");
  });

  it("caps the prefix at 99+", () => {
    expect(formatAppDocumentTitle(100)).toBe("(99+) Forta Chat");
    expect(formatAppDocumentTitle(99)).toBe("(99) Forta Chat");
  });

  it("uses a custom app name", () => {
    expect(formatAppDocumentTitle(3, "My App")).toBe("(3) My App");
  });
});

describe("applyAppDocumentTitle", () => {
  const prev = document.title;

  beforeEach(() => {
    document.title = "Forta Chat";
  });

  afterEach(() => {
    document.title = prev;
  });

  it("sets document.title with unread prefix", () => {
    applyAppDocumentTitle(5);
    expect(document.title).toBe("(5) Forta Chat");
  });

  it("clears the prefix when unread returns to 0", () => {
    applyAppDocumentTitle(5);
    applyAppDocumentTitle(0);
    expect(document.title).toBe("Forta Chat");
  });
});
