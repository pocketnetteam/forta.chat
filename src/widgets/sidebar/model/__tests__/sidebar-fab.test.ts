import { describe, it, expect } from "vitest";
import { getSidebarFabMode } from "../sidebar-fab";

/**
 * Regression: the AI tab showed the "Invite" FAB with no way to start a new
 * AI chat besides the small header "+" button. The AI tab now gets its own
 * "start new chat" FAB in place of the invite banner; every other tab keeps
 * the invite FAB unchanged.
 */
describe("getSidebarFabMode", () => {
  it("shows the AI new-chat FAB on the Chats tab's AI filter", () => {
    expect(
      getSidebarFabMode({ activeTab: "chats", searchQuery: "", activeFilter: "ai" }),
    ).toBe("ai-new-chat");
  });

  it("shows the invite FAB on the Chats tab for non-AI filters", () => {
    expect(
      getSidebarFabMode({ activeTab: "chats", searchQuery: "", activeFilter: "all" }),
    ).toBe("invite");
    expect(
      getSidebarFabMode({ activeTab: "chats", searchQuery: "", activeFilter: "personal" }),
    ).toBe("invite");
    expect(
      getSidebarFabMode({ activeTab: "chats", searchQuery: "", activeFilter: "channels" }),
    ).toBe("invite");
  });

  it("keeps the invite FAB on other sidebar tabs regardless of the stale AI filter", () => {
    expect(
      getSidebarFabMode({ activeTab: "contacts", searchQuery: "", activeFilter: "ai" }),
    ).toBe("invite");
    expect(
      getSidebarFabMode({ activeTab: "settings", searchQuery: "", activeFilter: "ai" }),
    ).toBe("invite");
  });

  it("hides both FABs while a search query is active", () => {
    expect(
      getSidebarFabMode({ activeTab: "chats", searchQuery: "alice", activeFilter: "ai" }),
    ).toBe("none");
    expect(
      getSidebarFabMode({ activeTab: "chats", searchQuery: "alice", activeFilter: "all" }),
    ).toBe("none");
  });

  it("treats a whitespace-only search query as empty", () => {
    expect(
      getSidebarFabMode({ activeTab: "chats", searchQuery: "   ", activeFilter: "all" }),
    ).toBe("invite");
  });
});
