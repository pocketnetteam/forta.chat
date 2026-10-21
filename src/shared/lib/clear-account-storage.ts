/**
 * Remove all account-specific localStorage keys.
 * Preserves device settings: theme, locale, call device preferences.
 * When address is provided, also removes per-account pinned/muted keys.
 */
export function clearAccountLocalStorage(address?: string): void {
  // Remove prefixed per-room keys
  const toRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (key.startsWith("bastyon-cache-ts:")) toRemove.push(key);
  }
  for (const key of toRemove) localStorage.removeItem(key);

  // Remove known account-specific keys
  localStorage.removeItem("bastyon-chat-join-room");
  localStorage.removeItem("bastyon-chat-referral");
  localStorage.removeItem("bastyon-chat-deleted-rooms");
  // Shared pin/mute keys an unbound session wrote; the next account must not inherit them.
  localStorage.removeItem("chat_pinned_rooms");
  localStorage.removeItem("chat_muted_rooms");

  if (address) clearPerAccountKeys(address);
}

/** Remove one account's own keys only (pinned and muted rooms, unsent read
 *  receipts, display name), e.g. when a background account is removed. */
export function clearPerAccountKeys(address: string): void {
  localStorage.removeItem(`chat_pinned_rooms:${address}`);
  localStorage.removeItem(`chat_muted_rooms:${address}`);
  localStorage.removeItem(`chat_pending_read_receipts:${address}`);
  localStorage.removeItem(`dsname_${address}`);
}
