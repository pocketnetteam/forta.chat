/**
 * Formats the browser tab title from total unread count.
 * Matches BottomTabBar badge capping at 99+.
 */
export function formatAppDocumentTitle(unread: number, appName = "Forta Chat"): string {
  if (unread <= 0) return appName;
  const label = unread > 99 ? "99+" : String(unread);
  return `(${label}) ${appName}`;
}

/** Apply unread-aware title to document.title (no-op outside a browser). */
export function applyAppDocumentTitle(unread: number, appName = "Forta Chat"): void {
  if (typeof document === "undefined") return;
  document.title = formatAppDocumentTitle(unread, appName);
}
