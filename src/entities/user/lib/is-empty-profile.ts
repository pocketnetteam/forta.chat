/**
 * A profile is "empty" when it has no display name.
 * Empty rows must never be persisted — they poison registration / peer lookups
 * (login-time getuserprofile before UserInfo lands caches "" forever).
 */
export function isEmptyUserProfile(
  profile: { name?: string | null } | null | undefined,
): boolean {
  if (!profile) return true;
  return !String(profile.name ?? "").trim();
}
