/**
 * True when every current room member has a loaded profile. The group common
 * key is wrapped only for loaded members, so encrypting before this holds sends
 * a key that the missing members can never unwrap (audit S1-01).
 */
export function everyMemberProfileLoaded(
  memberIds: readonly string[],
  loadedProfiles: Readonly<Record<string, unknown>>,
): boolean {
  return memberIds.length > 0 && memberIds.every((id) => Object.prototype.hasOwnProperty.call(loadedProfiles, id));
}
