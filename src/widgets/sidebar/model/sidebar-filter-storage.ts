/**
 * Persists the Chats-tab filter ("all" / "personal" / ...) across reloads.
 * Storage can be missing or throw (private mode, blocked site data), so every
 * access is guarded and falls back to "all".
 */
export type SidebarFilter = "all" | "personal" | "groups" | "invites" | "channels" | "ai";

export const SIDEBAR_FILTER_STORAGE_KEY = "chat_sidebar_filter";

const FILTERS: readonly SidebarFilter[] = ["all", "personal", "groups", "invites", "channels", "ai"];

/** Tabs that are always rendered; the rest appear only once their data loads. */
const ALWAYS_VISIBLE: readonly SidebarFilter[] = ["all", "personal", "groups"];

export function isSidebarFilter(value: unknown): value is SidebarFilter {
  return typeof value === "string" && (FILTERS as readonly string[]).includes(value);
}

export function isAlwaysVisibleFilter(value: SidebarFilter): boolean {
  return ALWAYS_VISIBLE.includes(value);
}

export function loadSidebarFilter(): SidebarFilter {
  try {
    const stored = localStorage.getItem(SIDEBAR_FILTER_STORAGE_KEY);
    return isSidebarFilter(stored) ? stored : "all";
  } catch {
    return "all";
  }
}

export function saveSidebarFilter(value: SidebarFilter): void {
  try {
    localStorage.setItem(SIDEBAR_FILTER_STORAGE_KEY, value);
  } catch {
    // Storage unavailable — the choice just won't survive a reload.
  }
}
