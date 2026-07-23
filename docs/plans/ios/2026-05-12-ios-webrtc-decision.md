# iOS WebRTC — Decision Plan (Skip Native Engine)

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Parent plan:** `2026-05-12-ios-overall-plan.md`

**Goal:** **Do not** ship a native WebRTC engine on iOS. Use WKWebView's built-in WebRTC stack and gate the existing `installNativeWebRTCProxy()` to Android-only. This converts the largest "Hard" iOS task into a small Vue/TS change.

**Why this is correct:** see "Critical reassessment" below.

---

## Critical reassessment

The Android-side `NativeWebRTCManager.kt` (~700 LOC) and the JS proxy `src/shared/lib/native-webrtc/rtc-peer-connection-proxy.ts` (~900 LOC) exist to solve **Android-specific** problems:

| Android problem | Code location | iOS situation |
|---|---|---|
| OEM hardware AEC deadlocks (Xiaomi MIUI, Realme UI, Oppo ColorOS, Infinix XOS, Tecno HiOS, Huawei EMUI, ZTE) | `NativeWebRTCManager.kt:62-77` `BROKEN_HW_AEC_VENDORS` | **Doesn't exist.** iOS = single vendor (Apple), single AEC implementation, single AVAudioSession. |
| WebView Chromium fragmentation (Chrome 75 ↔ 130) | `webview-compatibility.ts`, `BugReportModal.vue` | **Doesn't exist.** WKWebView is bound to OS version, single WebKit. |
| WebView WebRTC `restartIce` flaky on some Android Chrome builds | `rtc-peer-connection-proxy.ts:617-707` watchdog | WKWebView WebRTC follows WebKit nightly, gets timely fixes. |
| MIUI privacy shield silently rejecting AudioRecord | `CallPlugin.kt:probeAudioAvailability` | Apple permissions are binary and surfaced via `AVCaptureDevice.requestAccess`. |
| Need for hardware H.264 encoder fallback | `NativeWebRTCManager.kt` codec config | WKWebView already uses VideoToolbox (HW H.264). |
| Screen share via MediaProjection | `WebRTCPlugin.kt` | WKWebView supports `getDisplayMedia` since iOS 17 (with `RPSystemBroadcastPickerView` for system-wide). Out of scope for v1. |

**WKWebView WebRTC capabilities (verified 2026-05-12):**

- `RTCPeerConnection`, `getUserMedia({audio,video})`, `getDisplayMedia` — all available since **iOS 14.3**.
- Same WebKit code path as Safari, no fork.
- One known limitation: **microphone capture is muted when the app enters background** (iOS 15+). The fix is **not** to switch to a native engine — it is to use **CallKit + `AVAudioSession.Category.playAndRecord` + `.voiceChat` mode**, which we set up regardless for the call UI (see `2026-05-12-ios-callkit-pushkit.md`). When the call session is active, audio is allowed in background.

**Conclusion:** the native engine is an *Android workaround layer*, not an iOS need. Re-implementing `NativeWebRTCManager.kt` in Swift would be ~3–4 weeks of work with **no behavioral upside** on iOS, plus ongoing maintenance burden, plus the risk of introducing iOS bugs that the WKWebView team already fixed in WebKit.

---

## Plan B (escalation path)

If Phase 3 testing in the Overall plan reveals a WKWebView WebRTC blocker we cannot work around (e.g. ICE failure, audio-codec mismatch with Bastyon's TURN), the fallback is to integrate `WebRTC.xcframework` (Google's official iOS distribution) and build an iOS counterpart of `NativeWebRTCManager.kt`. We **defer** that decision to actual evidence — speculative work is not justified.

The cost estimate for Plan B is documented in `2026-05-12-ios-overall-plan.md` "Risk register" so the team has a number to plan against, but the *default* execution path of this document is "Plan A — skip native engine entirely".

---

## Tasks

### Task 1: Gate `installNativeWebRTCProxy()` to Android-only

**Files:**
- Modify: `src/features/video-calls/model/call-service.ts:62-67`
- Modify: `src/features/video-calls/model/call-service.test.ts` (mock import)

**Step 1: Replace `isNative` gate with `isAndroid`**

In `src/features/video-calls/model/call-service.ts`:

```typescript
// before
import { isNative } from "@/shared/lib/platform";
...
if (isNative) {
  installNativeWebRTCProxy();
  NativeWebRTC.addListener("onAudioError", (data) => { ... });
}
```

Change to:

```typescript
import { isNative, isAndroid } from "@/shared/lib/platform";
...
// On iOS we use WKWebView's built-in WebRTC — see
// docs/plans/ios/2026-05-12-ios-webrtc-decision.md.
// The native proxy + NativeWebRTCManager only exist for Android because
// WebView/OEM fragmentation forces us to bypass the WebView's WebRTC.
if (isAndroid) {
  installNativeWebRTCProxy();
  NativeWebRTC.addListener("onAudioError", (data) => { ... });
}
```

Update the comment block above the gate (lines 60–63) accordingly.

**Step 2: Update tests**

In `src/features/video-calls/model/call-service.test.ts`, the existing mock already sets `isAndroid: true` — no change. Add one new top-level describe block:

```typescript
describe("WebRTC engine selection — iOS path", () => {
  beforeEach(() => {
    vi.doMock('@/shared/lib/platform', () => ({
      isNative: true, isAndroid: false, isIOS: true, isElectron: false, isWeb: false,
    }));
  });
  it("does not install the native WebRTC proxy on iOS", async () => {
    vi.resetModules();
    const { installNativeWebRTCProxy } = await import('@/shared/lib/native-webrtc');
    await import('@/features/video-calls/model/call-service'); // triggers gate
    expect(installNativeWebRTCProxy).not.toHaveBeenCalled();
  });
});
```

**Step 3: Verify**

```
npx vue-tsc --noEmit
npx vitest run src/features/video-calls/model/call-service.test.ts
```

Expected: green.

**Step 4: Commit**

```
git add src/features/video-calls/model/call-service.ts src/features/video-calls/model/call-service.test.ts
git commit -m "feat(ios): use WKWebView built-in WebRTC, gate native proxy to Android"
```

---

### Task 2: Make `getRealGetUserMedia` Android-only too

**Files:**
- Audit: `src/shared/lib/native-webrtc/rtc-peer-connection-proxy.ts:766-781`
- Audit callers: `src/features/messaging/model/use-voice-recorder.ts`, `use-video-circle-recorder.ts`

**Why:** `getRealGetUserMedia()` returns the original `navigator.mediaDevices.getUserMedia` so voice/video recorders do not get the dummy stream the proxy returns. On iOS, since the proxy is **never installed**, `navigator.mediaDevices.getUserMedia` is already the real one — `getRealGetUserMedia()` is harmless but a code smell.

**Step 1: Document and leave the function**

The function body already does `navigator.mediaDevices?.getUserMedia?.bind(...)` at module load. On iOS that capture happens before any proxy install (which never runs anyway), so it always returns the real one. No change needed.

Add a comment to the export (`src/shared/lib/native-webrtc/rtc-peer-connection-proxy.ts:779`):

```typescript
/**
 * Returns the real browser getUserMedia, bypassing the native WebRTC proxy.
 * Use this in voice/video recorders that need actual media streams.
 *
 * On iOS the proxy is never installed (see
 * docs/plans/ios/2026-05-12-ios-webrtc-decision.md) — this function still
 * returns navigator.mediaDevices.getUserMedia, which IS the real one there.
 */
export function getRealGetUserMedia() { ... }
```

**Step 2: No code change. Commit the comment.**

```
git add src/shared/lib/native-webrtc/rtc-peer-connection-proxy.ts
git commit -m "docs(webrtc): clarify getRealGetUserMedia behavior on iOS"
```

---

### Task 3: Wire `Info.plist` permissions and audio session

**Files:**
- Create: `ios/App/App/Info.plist` (or modify if `cap add ios` generated it).

**Step 1: Add usage strings**

Required for WKWebView to call `getUserMedia`:

```xml
<key>NSMicrophoneUsageDescription</key>
<string>Forta Chat uses your microphone for voice and video calls and voice messages.</string>
<key>NSCameraUsageDescription</key>
<string>Forta Chat uses your camera for video calls and to take photos to share.</string>
```

Without these strings WKWebView **silently rejects** `getUserMedia` with `NotAllowedError`, even if you grant the OS prompt. This is the single most common iOS WebRTC pitfall — make sure CI fails the build if either key is missing.

**Step 2: Background modes (declared here, used by callkit-pushkit.md)**

```xml
<key>UIBackgroundModes</key>
<array>
  <string>voip</string>
  <string>audio</string>
  <string>remote-notification</string>
</array>
```

**Step 3: WKWebView capture allowance**

In `ios/App/App/AppDelegate.swift` (generated by Capacitor), confirm the `WKWebView`'s configuration sets:

```swift
config.allowsInlineMediaPlayback = true
config.mediaTypesRequiringUserActionForPlayback = []
```

Capacitor 8 sets these by default; verify and document. No change needed if defaults hold.

**Step 4: Commit**

```
git add ios/App/App/Info.plist
git commit -m "ios: add microphone/camera usage strings + background modes"
```

---

### Task 4: Smoke test — place a call from iOS simulator

**Manual checklist (no code changes):**

1. Build & run on iOS 15+ simulator (camera/mic faked) and on a real iPhone (test device).
2. Sign in.
3. Open a 1-on-1 chat with a known partner.
4. Place a voice call. Expect: foreground call works, audio bidirectional, hang-up cleanly.
5. Place a video call. Expect: local + remote video, switch camera works.
6. Mid-call, background the app. Expect: audio drops within ~1s (this is the known iOS limitation we will fix in callkit-pushkit.md). Hang-up cleanly when foregrounded.
7. Receive a call (WebView app in foreground). Expect: ringer sound + accept works (CallKit ringer comes later).

**If any of 4–6 fails:** open `2026-05-12-ios-webrtc-decision.md` "Plan B" and escalate to integrating Google's `WebRTC.xcframework`.

Document results in the test plan section of the PR description.

---

## Verification gate (end of plan)

- [ ] `npx vue-tsc --noEmit` — green.
- [ ] `npx vitest run` — green.
- [ ] `npm run build` — green.
- [ ] iOS simulator launches the app, login + chat both work.
- [ ] Foreground voice & video call between iOS device and Android device — bidirectional audio/video.

## Out of scope

- Background mid-call audio (handled by `2026-05-12-ios-callkit-pushkit.md`).
- Screen share on iOS (`getDisplayMedia` works in iOS 17+ but UI is out of scope for v1).
- Audio device routing (earpiece / speaker / Bluetooth) — managed by AVAudioSession in `2026-05-12-ios-callkit-pushkit.md`, not by a JS proxy.

