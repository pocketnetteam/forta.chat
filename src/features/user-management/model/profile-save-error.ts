/** Why a profile save failed, as app-initializer's editUserData reports it. */
export type ProfileSaveFailure = "timeout" | "rejected" | "network";

/**
 * i18n key for a failed profile save. editUserData knows why it failed, but the
 * form always said "check your connection", which is wrong advice when the
 * network answered and refused the change (audit W2A-04, forta-bugs#1180,
 * #1285, #1242).
 */
export function profileSaveErrorKey(
  reason: ProfileSaveFailure | undefined,
): "profile.saveFailedTimeout" | "profile.saveFailedRejected" | "profile.saveFailed" {
  if (reason === "timeout") return "profile.saveFailedTimeout";
  if (reason === "rejected") return "profile.saveFailedRejected";
  return "profile.saveFailed";
}
