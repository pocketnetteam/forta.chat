/**
 * Detects whether the current Chrome / WebView build is too old to drive
 * a modern WebRTC call reliably.
 *
 * Background — Session 30. Reports from Huawei Honor 8X (Android 10) and
 * other GMS-stripped Android 10 devices (#653, #600) show the call reaching
 * `connected` state and then dropping within seconds. Their Android System
 * WebView is frozen at the build that shipped with the firmware — for
 * EMUI 10 that's roughly Chromium 90-96, well before the libwebrtc
 * stabilisation work that landed across Chromium 96-100.
 *
 * The Bastyon WebRTC proxy issues `restartIce` on transient connectivity
 * loss (see [registerNetworkChangeRestart] in call-service.ts). The
 * empirical observation from the affected devices is that this restart
 * leaves `signalingState` wedged on those builds — i.e. the recovery path
 * is the failure surface. We don't have a libwebrtc commit cited as the
 * exact fix point, so this is a heuristic: pick a conservative cutoff
 * that comfortably excludes the in-the-wild bug-report devices, and
 * revisit if telemetry shows we're flagging too aggressively.
 *
 * Scope: this guard only runs on the web/Electron path. On native, the
 * SDK uses a bundled libwebrtc via the NativeWebRTC bridge — the WebView
 * Chrome version reported by `navigator.userAgent` has no relation to
 * what's actually negotiating ICE. See call-service.ts where the gate is
 * scoped to `!isNative`.
 *
 * This module is a pure UA parser so it can be unit-tested without the
 * full call stack. Anything that reads the result calls `getWebViewInfo`
 * directly and decides per-feature whether to disable a recovery path.
 */

/**
 * Empirically chosen Chromium major version below which our recovery paths
 * (notably restartIce on network change) are known to wedge in-the-wild on
 * the bug-report devices. Not tied to a specific libwebrtc commit — the
 * floor was picked by inspecting the affected devices' UA strings and
 * leaving headroom. Tighten or relax once we have telemetry.
 */
export const MIN_CHROMIUM_MAJOR_FOR_MODERN_WEBRTC = 100;

export type WebViewInfo =
  | { engine: "chromium"; major: number; raw: string }
  | { engine: "unknown"; raw: string };

/**
 * Parse the user-agent string into a structured WebViewInfo. Accepts an
 * explicit UA so tests can pass a fixture without monkey-patching navigator;
 * production callers default to `navigator.userAgent`.
 *
 * Looks for the `Chrome/<n>` token: Android System WebView injects this
 * regardless of branding. Extracting only the integer major lets us match
 * Chromium ESR backports that bump the patch level without affecting the
 * compatibility decision.
 */
export function getWebViewInfo(
  userAgent: string = typeof navigator !== "undefined" ? navigator.userAgent : "",
): WebViewInfo {
  if (!userAgent) {
    return { engine: "unknown", raw: userAgent };
  }
  const match = userAgent.match(/Chrome\/(\d+)/);
  if (!match) {
    return { engine: "unknown", raw: userAgent };
  }
  const major = Number.parseInt(match[1], 10);
  if (!Number.isFinite(major) || major <= 0) {
    return { engine: "unknown", raw: userAgent };
  }
  return { engine: "chromium", major, raw: userAgent };
}

/**
 * True when the current WebView is known too old for our modern WebRTC
 * recovery paths (restartIce, ICE consent renegotiation). When this returns
 * `true`, the call-service skips automatic ICE restart on network changes
 * and surfaces a one-time UI hint to the user telling them to update
 * Android System WebView.
 *
 * Returns `false` for unknown engines — those are usually desktop Electron
 * or modern Safari, which are not the target of this guard. Better to allow
 * recovery on unknown UAs than to silently disable it for everyone.
 */
export function isLegacyWebView(
  userAgent?: string,
  threshold: number = MIN_CHROMIUM_MAJOR_FOR_MODERN_WEBRTC,
): boolean {
  const info = getWebViewInfo(userAgent);
  if (info.engine !== "chromium") return false;
  return info.major < threshold;
}
