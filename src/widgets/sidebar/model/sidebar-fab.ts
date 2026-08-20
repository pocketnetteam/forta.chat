/**
 * Pure decision helper for which floating action button the Chats-tab
 * sidebar shows at the bottom. The AI tab has no server-side "invite" concept
 * (chats are local-only), so it gets a "start new chat" FAB instead of the
 * invite banner — everywhere else keeps the invite FAB unchanged.
 * Kept side-effect-free so the swap can be unit-tested without mounting the
 * full sidebar (mirrors chat-back-actions.ts's approach).
 */
export interface SidebarFabState {
  /** Active sidebar tab ("chats" | "contacts" | "settings"). */
  activeTab: string;
  /** Current sidebar search query (empty string when inactive). */
  searchQuery: string;
  /** Active filter tab ("all" | "personal" | "groups" | "invites" | "channels" | "ai"). */
  activeFilter: string;
}

export type SidebarFabMode = "none" | "ai-new-chat" | "invite";

/** Which bottom FAB (if any) the sidebar should render for the given state. */
export function getSidebarFabMode(state: SidebarFabState): SidebarFabMode {
  if (state.searchQuery.trim().length > 0) return "none";
  if (state.activeTab === "chats" && state.activeFilter === "ai") return "ai-new-chat";
  return "invite";
}
