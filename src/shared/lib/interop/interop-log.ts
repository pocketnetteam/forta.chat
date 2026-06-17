/**
 * Diagnostic logging for Bastyon↔Forta cross-app interaction boundaries
 * (WEE-35 Task 1). When both apps are installed they share the same Matrix
 * backend, Bastyon identity and FCM project, so the seams — existing-account
 * login, call-push receipt, call-invite handling — are where conflicts surface.
 *
 * Markers use a stable `[interop:<scope>]` prefix (matching the repo's
 * `[Module]` console convention) so they're greppable in `adb logcat` when
 * reproducing a dual-install report on a device.
 */

export type InteropScope = "auth" | "push" | "call";

/** Emit a cross-app diagnostic marker. */
export function interopLog(
  scope: InteropScope,
  message: string,
  data?: Record<string, unknown>
): void {
  const prefix = `[interop:${scope}]`;
  if (data !== undefined) {
    console.info(prefix, message, data);
  } else {
    console.info(prefix, message);
  }
}
