import { describe, it, expect } from "vitest";
import { shouldClearSearch, shouldResetFilter } from "../chat-back-actions";

/**
 * Regression (WEE-67 / forta-bugs#877): Android Back from a non-default filter
 * tab ("Личные"/"Группы") must collapse back to "Все" instead of falling
 * through to App.minimizeApp(). Search clearing takes precedence over the
 * filter reset.
 */
describe("chat back actions (WEE-67)", () => {
  describe("shouldResetFilter", () => {
    it("collapses a non-default filter on the Chats tab", () => {
      expect(
        shouldResetFilter({ activeTab: "chats", searchQuery: "", activeFilter: "personal" }),
      ).toBe(true);
      expect(
        shouldResetFilter({ activeTab: "chats", searchQuery: "", activeFilter: "groups" }),
      ).toBe(true);
    });

    it("passes through when already on the 'all' filter", () => {
      expect(
        shouldResetFilter({ activeTab: "chats", searchQuery: "", activeFilter: "all" }),
      ).toBe(false);
    });

    it("does not fire outside the Chats tab", () => {
      expect(
        shouldResetFilter({ activeTab: "contacts", searchQuery: "", activeFilter: "personal" }),
      ).toBe(false);
      expect(
        shouldResetFilter({ activeTab: "settings", searchQuery: "", activeFilter: "groups" }),
      ).toBe(false);
    });
  });

  describe("shouldClearSearch", () => {
    it("clears an active search on the Chats tab", () => {
      expect(
        shouldClearSearch({ activeTab: "chats", searchQuery: "alice", activeFilter: "all" }),
      ).toBe(true);
    });

    it("passes through when search is empty", () => {
      expect(
        shouldClearSearch({ activeTab: "chats", searchQuery: "", activeFilter: "personal" }),
      ).toBe(false);
    });

    it("does not fire outside the Chats tab", () => {
      expect(
        shouldClearSearch({ activeTab: "contacts", searchQuery: "alice", activeFilter: "all" }),
      ).toBe(false);
    });

    it("takes precedence: search clears before filter resets", () => {
      const state = { activeTab: "chats", searchQuery: "bob", activeFilter: "groups" };
      // Both conditions are true; the higher-priority (56) search handler runs
      // first and consumes Back, so the filter (54) is not yet touched.
      expect(shouldClearSearch(state)).toBe(true);
      expect(shouldResetFilter(state)).toBe(true);
    });
  });
});
