/**
 * Pure decision helpers for the Chats-tab Android Back cascade
 * (forta-bugs#877). Kept side-effect-free so the priority contract can be
 * unit-tested without mounting the full sidebar.
 *
 * Cascade order (higher priority fires first):
 *   56 — clear an active search
 *   55 — sidebar tab → Chats (owned by ChatPage)
 *   54 — collapse a non-default filter tab → "all"
 */
export interface ChatBackState {
  /** Active sidebar tab ("chats" | "contacts" | "settings"). */
  activeTab: string;
  /** Current sidebar search query (empty string when inactive). */
  searchQuery: string;
  /** Active filter tab ("all" | "personal" | "groups" | "invites" | "channels"). */
  activeFilter: string;
}

/** True when Android Back should clear the active search on the Chats tab. */
export function shouldClearSearch(state: ChatBackState): boolean {
  return state.activeTab === "chats" && state.searchQuery.length > 0;
}

/** True when Android Back should collapse a non-default filter tab to "all". */
export function shouldResetFilter(state: ChatBackState): boolean {
  return state.activeTab === "chats" && state.activeFilter !== "all";
}
