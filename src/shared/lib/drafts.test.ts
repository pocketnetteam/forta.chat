import { describe, it, expect, beforeEach } from "vitest";
import { getDraft, saveDraft, clearDraft, _resetMigration } from "./drafts";

describe("drafts", () => {
  beforeEach(() => {
    localStorage.clear();
    _resetMigration();
  });

  it("returns empty string for non-existent draft", () => {
    expect(getDraft("!room:server")).toBe("");
  });

  it("saves and retrieves a draft", () => {
    saveDraft("!room1:server", "Hello world");
    expect(getDraft("!room1:server")).toBe("Hello world");
  });

  it("clears a draft", () => {
    saveDraft("!room1:server", "draft text");
    clearDraft("!room1:server");
    expect(getDraft("!room1:server")).toBe("");
  });

  it("does not save empty/whitespace drafts", () => {
    saveDraft("!room1:server", "  ");
    expect(getDraft("!room1:server")).toBe("");
  });

  it("removes existing draft when saving empty text", () => {
    saveDraft("!room1:server", "some text");
    saveDraft("!room1:server", "");
    expect(getDraft("!room1:server")).toBe("");
  });

  it("keeps drafts independent across rooms", () => {
    saveDraft("!room1:server", "draft1");
    saveDraft("!room2:server", "draft2");
    expect(getDraft("!room1:server")).toBe("draft1");
    expect(getDraft("!room2:server")).toBe("draft2");
  });

  it("migrates legacy single-key format on first access", () => {
    // Simulate legacy format
    localStorage.setItem("bastyon-chat:drafts", JSON.stringify({
      "!room1:server": "old draft 1",
      "!room2:server": "old draft 2",
    }));
    expect(getDraft("!room1:server")).toBe("old draft 1");
    expect(getDraft("!room2:server")).toBe("old draft 2");
    // Legacy key should be removed after migration
    expect(localStorage.getItem("bastyon-chat:drafts")).toBeNull();
  });

  it("recovers from corrupted legacy JSON in localStorage", () => {
    localStorage.setItem("bastyon-chat:drafts", "not valid json{{{");
    expect(getDraft("!room1:server")).toBe("");
  });

  it("overwrites previous draft for same room", () => {
    saveDraft("!room1:server", "first");
    saveDraft("!room1:server", "second");
    expect(getDraft("!room1:server")).toBe("second");
  });
});
