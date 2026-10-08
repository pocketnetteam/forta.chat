/**
 * Android WebRTC engine setup that runs once per process when the call service loads:
 * the native RTCPeerConnection proxy, the native audio-error listener and the
 * Wi-Fi/cellular ICE restart. Split out of call-service.ts without behaviour change.
 */
import type { MatrixCall } from "matrix-js-sdk-bastyon/lib/webrtc/call";
import { CallStatus, useCallStore } from "@/entities/call";
import { isAndroid, isNative } from "@/shared/lib/platform";
import { tRaw } from "@/shared/lib/i18n";
import { NativeWebRTC, installNativeWebRTCProxy, isNativeWebRTCEngineEnabled } from "@/shared/lib/native-webrtc";
import { onConnectivityChange } from "@/shared/lib/connectivity";
import { useToast } from "@/shared/lib/use-toast";
import { MIN_CHROMIUM_MAJOR_FOR_MODERN_WEBRTC, isLegacyWebView, shouldWarnLegacyWebView } from "./webview-compatibility";

/**
 * One-shot guard so the legacy-WebView toast fires only once per process,
 * not every time the user changes networks during a single call. Reset
 * implicitly by a full app restart, which is correct: the user may have
 * updated WebView in the meantime.
 */
let legacyWebViewToastShown = false;

export function maybeWarnLegacyWebView(): void {
  // Self-gating so call sites (call start, answer, mid-call restart skip)
  // can fire-and-forget without each duplicating the native/legacy/one-shot
  // policy. Native negotiates ICE through bundled libwebrtc, so the UA Chrome
  // version is meaningless there — never warn on native.
  if (
    !shouldWarnLegacyWebView({
      isNative,
      isLegacy: isLegacyWebView(),
      alreadyWarned: legacyWebViewToastShown,
    })
  ) {
    return;
  }
  legacyWebViewToastShown = true;
  try {
    // The shared toast surface only models info/success/error severities.
    // We use "info" with an extended duration (6s) so the user has time
    // to read the Play Store update hint without it feeling like a hard
    // error — the call may still complete on best-effort signaling.
    useToast().toast(tRaw("call.error.legacyWebView"), "info", 6000);
  } catch (e) {
    console.warn("[call-service] legacy WebView toast failed:", e);
  }
}

// Module-scope handle for the connectivity subscription so we don't stack
// listeners on HMR / repeated module evaluation. Declared above the
// `if (isNative)` block so the function can read it without hitting TDZ.
let _networkChangeUnsubscribe: (() => void) | null = null;

// Install native WebRTC proxy on Android only — must run before any call is placed.
// This replaces window.RTCPeerConnection so that the Matrix SDK transparently
// uses the native Android WebRTC engine instead of the browser's.
//
// iOS deliberately uses WKWebView's built-in WebRTC stack — see
// docs/plans/ios/2026-05-12-ios-webrtc-decision.md. The NativeWebRTCManager
// + JS proxy exist to work around Android-specific issues (OEM HW AEC
// deadlocks, WebView Chromium fragmentation, restartIce flakiness on old
// Android Chrome builds, MIUI privacy shield silently rejecting AudioRecord)
// — none of which apply to iOS, where WKWebView is a single vendor-controlled
// engine that follows Safari's WebRTC implementation. Installing the proxy on
// iOS would hand the SDK a no-op `NativeWebRTC` plugin (no Swift counterpart
// exists for Plan A) and silently break call setup.
//
// `isNativeWebRTCEngineEnabled()` is the runtime escape hatch: a user (or
// support) can switch a device to the WebView engine from settings when the
// native path misbehaves, without waiting for a release. It gates the media
// proxy only — native call UI, foreground service and audio routing stay in
// place either way, so the two modes differ purely in which stack carries
// the media. See webrtc-engine-preference.ts.
if (isAndroid && isNativeWebRTCEngineEnabled()) {
  installNativeWebRTCProxy();

  // D-11: Listen for native audio errors. Stays inside the engine gate:
  // every emitter of this event (WebRTCPlugin.startLocalMedia and
  // NativeWebRTCManager's AudioSource/AudioTrack failures) sits on the native
  // media path, so with the proxy dormant nothing can raise it.
  NativeWebRTC.addListener("onAudioError", (data) => {
    console.warn(`[call-service] Native audio error: ${data.type} — ${data.message}`);
    const callStore = useCallStore();
    if (data.type === "permission_denied") {
      callStore.updateStatus(CallStatus.failed);
      callStore.scheduleClearCall(1500);
    }
  });
}

// Outside the engine gate on purpose: this acts on `matrixCall.peerConn`, the
// SDK's own RTCPeerConnection, which exists in both modes — the native engine
// only supplies its media. Folding it into the engine condition meant that
// switching to the WebView engine — which support does precisely when a device
// has audio trouble — also silently disabled WiFi↔cellular recovery on exactly
// the devices that needed it most.
if (isAndroid) {
  // Session 03: WiFi↔cellular handover does not reliably fire
  // window.online/offline on Android WebView. We subscribe to
  // @capacitor/network instead so transport flips during a live call
  // trigger an explicit ICE restart instead of waiting for the SDK's
  // sentinel timeout (by which time the call has already dropped).
  //
  // Idempotent registration: HMR / repeated module evaluation must not
  // stack listeners. We hold the unsubscribe handle so a future teardown
  // path (e.g. a hot reload helper) can call it; right now we only need
  // the once-per-process guarantee.
  registerNetworkChangeRestart();
}

function registerNetworkChangeRestart(): void {
  if (_networkChangeUnsubscribe) return;
  _networkChangeUnsubscribe = onConnectivityChange((change) => {
    if (!change.connected) return;
    if (change.previousType === change.type) return;

    const callStore = useCallStore();
    const matrixCall = callStore.matrixCall as MatrixCall | null;
    if (!matrixCall) return;
    const pc = (matrixCall as unknown as { peerConn?: RTCPeerConnection })
      .peerConn;
    if (!pc) return;

    // Don't restart while the SDK is mid-glare (have-local-offer /
    // have-remote-offer / have-local-pranswer / have-remote-pranswer):
    // a second restartIce in that window leaves libwebrtc with mismatched
    // SDP state and we end up wedged in "checking" forever — exactly the
    // failure mode this code is meant to prevent. The proxy's
    // restartIce() also debounces concurrent calls, but the cheaper
    // check here is to skip the call entirely if signaling is unstable.
    if (pc.signalingState !== "stable") {
      console.log(
        `[call-service] skip restartIce on network change (${change.previousType}→${change.type}); signalingState=${pc.signalingState}`,
      );
      return;
    }

    const state = pc.iceConnectionState;
    if (
      state === "connected" ||
      state === "completed" ||
      state === "disconnected" ||
      state === "checking"
    ) {
      // Session 30: Huawei Android 10 (HONOR 8X / STK-LX1) and similar
      // GMS-stripped devices ship Chromium ~83-96 in Android System WebView.
      // restartIce on those builds wedges signalingState in "have-local-offer"
      // because the rollback path for ICE renegotiation was buggy until
      // Chromium 100. Skip the recovery and let the SDK end the call
      // gracefully — far better UX than a frozen "connecting…" loop. We
      // surface a one-time toast so the user can update WebView from Play
      // Store; calling that out here (during a real network event) is
      // higher signal than at call start where most users dismiss it.
      // C1: WebView-engine guard only applies to web/Electron callers. On
      // native (Android/iOS), `installNativeWebRTCProxy` swaps the SDK's
      // RTCPeerConnection for a native bridge — `pc.restartIce()` here
      // forwards to the platform's bundled libwebrtc, not the WebView's.
      // `navigator.userAgent` reports the WebView Chrome version which has
      // no bearing on the actual ICE engine. Running the guard on native
      // would falsely block recovery on devices whose bundled libwebrtc
      // is fine, while doing nothing for the very devices the guard was
      // meant to help (since their Vue UI never drives this code path on
      // the bug-report flow). The native side has its own connectiondead
      // path (see [call-service.ts onPeerConnectionCreated]) which already
      // surfaces a typed error to the user.
      if (!isNative && isLegacyWebView()) {
        console.warn(
          `[call-service] skip restartIce on network change (${change.previousType}→${change.type}); legacy WebView (Chromium <${MIN_CHROMIUM_MAJOR_FOR_MODERN_WEBRTC})`,
        );
        maybeWarnLegacyWebView();
        return;
      }
      console.warn(
        `[call-service] network ${change.previousType}→${change.type}, restartIce`,
      );
      try {
        pc.restartIce();
      } catch (e) {
        console.error(
          "[call-service] restartIce on network change failed:",
          e,
        );
      }
    }
  });
}

// ---------------------------------------------------------------------------
// SDK state → store status mapping
// ---------------------------------------------------------------------------
