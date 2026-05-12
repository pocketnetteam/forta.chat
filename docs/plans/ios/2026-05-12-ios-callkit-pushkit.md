# iOS CallKit + PushKit Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Parent plan:** `2026-05-12-ios-overall-plan.md`

**Goal:** Replace the Android Telecom-based call ringer (`CallPlugin.kt`, `CallConnectionService.kt`, `IncomingCallActivity.kt`, `CallActivity.kt`, `CallForegroundService.kt`, `AudioRouter.kt`) with iOS CallKit + PushKit + AVAudioSession. Match the JS-side bridge contract (`src/shared/lib/native-calls/native-call-bridge.ts`) so no Vue/Pinia code changes are needed beyond a small platform branch.

---

## Critical reassessment

Before writing native Swift, we **must** check the plugin landscape.

### Existing plugin: `@capgo/capacitor-incoming-call-kit` (v8.x, Capacitor 8 compatible, last release 2026-04)

What it gives us — **map directly to the existing JS bridge**:

| JS bridge method | Plugin equivalent | Replaces Android Kotlin |
|---|---|---|
| `reportIncomingCall({callId, callerName, roomId, hasVideo})` | `IncomingCallKit.showIncomingCall({...})` | `CallPlugin.reportIncomingCall` + `TelecomManager.addNewIncomingCall` |
| `reportCallConnected({callId})` | `IncomingCallKit.markConnected({callId})` | `CallConnection.setActive()` |
| `reportCallEnded({callId})` | `IncomingCallKit.endCall({callId})` | `CallConnection.onDisconnect()` |
| `getPendingAnswer()` | `IncomingCallKit.getPendingAnswer()` (built-in buffering) | `CallConnection.pendingAnswerCallId` static |
| `getPendingReject()` | `IncomingCallKit.getPendingReject()` | `CallConnection.pendingRejectCallId` static |
| `addListener('callAnswered'\|'callDeclined'\|'callEnded', ...)` | Same event names emitted by the plugin | `notifyListeners(...)` in `CallPlugin.kt` |

What it **does not** give us — we own:

- **PushKit registration & VoIP push routing** (separate plugin or small Swift glue).
- **AVAudioSession** category/mode setup (small Swift glue, fired on `callAccepted` and on `callConnected`).
- **Audio device enumeration / routing** (`getAudioDevices`, `setAudioDevice`, `audioDevicesChanged` event) — on iOS this is **AVAudioSession.availableInputs** + `setPreferredInput`. Different model from Android: instead of "switch to BT/speaker", iOS shows a system route picker. Recommendation: stub `getAudioDevices` to return only `["default"]` on iOS for v1, defer custom picker UI.
- **`probeAudioAvailability`** — on iOS, just check `AVAudioSession.recordPermission` + try to set the category. Far simpler than Android.
- **`getInviteThrottleSnapshot`** (Android FCM throttle telemetry) — return empty array on iOS for v1.

### Existing plugin: PushKit (VoIP push)

There is no first-party Capacitor PushKit plugin. Two options:

- **Option A — write a tiny custom Capacitor plugin** (~150 LOC Swift). Just registers `PKPushRegistry`, surfaces the VoIP token to JS so we can register the Matrix Sygnal pusher with `app_id: 'fortaios.voip'`. This is the recommended path — no maintenance burden from a third-party.
- **Option B — bundle PushKit into the IncomingCallKit setup** (some forks do). More magical but couples two unrelated concerns.

**Decision: Option A.** A custom 150-LOC `IOSVoIPPush` plugin we control end-to-end.

### Decision summary

- Use `@capgo/capacitor-incoming-call-kit` for the call UI surface (CallKit on iOS, full-screen on Android — but we keep our existing Android Kotlin since it's already battle-tested; the plugin runs only on iOS).
- Custom Swift plugin `IOSVoIPPush` for PushKit registration + VoIP token exposure.
- Custom Swift plugin `IOSCallAudio` for AVAudioSession setup/teardown.
- Replace Android-only methods (`probeAudioAvailability`, `forceStopAudio`, `getAudioStatus`, `getInviteThrottleSnapshot`) with safe iOS stubs in TS.

---

## Architecture diagram

```
m.call.invite arrives at Sygnal
    │
    ├── Android pusher (app_id: fortaandroid)  → FCM data push  → FortaFirebaseMessagingService → CallPlugin.reportIncomingCall
    └── iOS    pusher (app_id: fortaios.voip)  → APNs VoIP push → IOSVoIPPush.didReceiveIncomingPush
                                                                          ↓
                                                                   IncomingCallKit.showIncomingCall
                                                                          ↓ (system displays CallKit UI)
                                                                   user taps Accept
                                                                          ↓
                                                                   CXAnswerCallAction → emit "callAnswered"
                                                                          ↓ (JS event listener inside native-call-bridge.ts)
                                                                   pendingAnswerCallId set → call-service.answerCall()
                                                                          ↓
                                                                   IOSCallAudio.start({callType:"voice"|"video"})
                                                                          ↓
                                                                   WKWebView WebRTC sets up RTCPeerConnection
                                                                          ↓
                                                                   reportCallConnected → CXProvider.reportOutgoingCall(...connectedAt:)
```

---

## Tasks

### Task 1: Install `@capgo/capacitor-incoming-call-kit`

**Files:**
- Modify: `package.json`
- Modify: `capacitor.config.ts`

**Step 1: Install**

```
npm install @capgo/capacitor-incoming-call-kit@^8
npx cap sync ios
```

**Step 2: Configure**

In `capacitor.config.ts`, add under `plugins`:

```typescript
IncomingCallKit: {
  callKitName: 'Forta Chat',
  // iOS only: file under ios/App/App/ for ringtone
  ringtone: 'ringtone.caf',
  // Android only: we keep our existing Kotlin so disable the Android path
  enableAndroid: false,
}
```

**Step 3: Verify build**

```
npm run build && npx cap sync ios
```

**Step 4: Commit**

```
git add package.json package-lock.json capacitor.config.ts
git commit -m "feat(ios): install @capgo/capacitor-incoming-call-kit for CallKit ringer"
```

---

### Task 2: Wrap the new plugin behind the existing `nativeCallBridge` interface

**Files:**
- Modify: `src/shared/lib/native-calls/native-call-bridge.ts`
- Create: `src/shared/lib/native-calls/native-call-bridge.ios.ts`

**Why:** the existing bridge surface (`reportIncomingCall`, `reportCallEnded`, `addListener('callAnswered',...)`, etc.) is consumed all over the call layer. We do **not** want to touch consumers. Instead, internally route to `NativeCall` (Android) or `IncomingCallKit` (iOS).

**Step 1: Extract iOS adapter**

Create `src/shared/lib/native-calls/native-call-bridge.ios.ts` with the same shape as the Android `NativeCallNativePlugin` interface, backed by `@capgo/capacitor-incoming-call-kit`:

```typescript
import { registerPlugin } from '@capacitor/core';
interface IncomingCallKitPlugin {
  showIncomingCall(opts: { callId: string; handle: string; hasVideo: boolean }): Promise<void>;
  endCall(opts: { callId: string }): Promise<void>;
  markConnected(opts: { callId: string }): Promise<void>;
  getPendingAnswer(): Promise<{ callId: string | null }>;
  getPendingReject(): Promise<{ callId: string | null }>;
  addListener(ev: 'callAccepted' | 'callDeclined' | 'callEnded' | 'callTimedOut',
              cb: (data: { callId: string }) => void): Promise<{ remove: () => void }>;
}
export const IncomingCallKit = registerPlugin<IncomingCallKitPlugin>('IncomingCallKit');
```

**Step 2: Branch in `native-call-bridge.ts`**

Change the file's `wire()`, `reportIncomingCall()`, `reportCallEnded()`, `reportCallConnected()`, `consumePendingAnswerCallId()`, `consumePendingRejectCallId()` to call either Android `NativeCall` or iOS `IncomingCallKit` based on `isIOS`/`isAndroid`. Map iOS event names (`callAccepted`/`callDeclined`/`callEnded`) to the existing Android event names (`callAnswered`/`callDeclined`/`callEnded`) so the JS callbacks stay identical.

**Step 3: Stub Android-only methods on iOS**

These don't apply on iOS — return safe defaults:

- `requestAudioPermission()` → `AVAudioSession.requestRecordPermission` via the IOSCallAudio plugin (Task 4).
- `requestCameraPermission()` → use `@capacitor/camera`'s `requestPermissions()`.
- `probeAudioAvailability()` → check `AVAudioSession.recordPermission == .granted` and try `setActive(true)`. Single ~30-LOC method.
- `forceStopAudio()` / `stopAudioRouting()` / `startAudioRouting()` → routed to IOSCallAudio (Task 4).
- `getAudioStatus()` → returns `{ mode: AVAudioSession.sharedInstance().category == .playAndRecord ? 'MODE_IN_COMMUNICATION' : 'MODE_NORMAL', isSpeakerOn, isBtScoOn: false }`.
- `getAudioDevices()` / `setAudioDevice()` → return `[{type:'default', name:'Default'}]` for v1, expose AVAudioSession picker only when `getAudioDevices` is wired up (out of v1).
- `getInviteThrottleSnapshot()` → return `{ records: [] }`. Android-specific FCM throttle telemetry; not applicable.

**Step 4: Update tests**

Mirror the existing call-service tests with an `isIOS: true` branch verifying that `IncomingCallKit.showIncomingCall` is called (instead of `NativeCall.reportIncomingCall`).

**Step 5: Verify**

```
npx vue-tsc --noEmit
npx vitest run src/shared/lib/native-calls
npm run build
```

**Step 6: Commit**

```
git add src/shared/lib/native-calls/
git commit -m "feat(ios): route nativeCallBridge to @capgo/capacitor-incoming-call-kit"
```

---

### Task 3: Custom `IOSVoIPPush` Capacitor plugin

**Files (new):**
- `ios/App/App/IOSVoIPPushPlugin.swift`
- `ios/App/App/IOSVoIPPushPlugin.m`
- `src/shared/lib/push/ios-voip-push.ts`

**Step 1: Swift implementation (~150 LOC)**

```swift
import Capacitor
import PushKit
import CallKit

@objc(IOSVoIPPushPlugin)
public class IOSVoIPPushPlugin: CAPPlugin, PKPushRegistryDelegate {
    private var registry: PKPushRegistry!

    override public func load() {
        registry = PKPushRegistry(queue: .main)
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
    }

    public func pushRegistry(_ registry: PKPushRegistry,
                             didUpdate pushCredentials: PKPushCredentials,
                             for type: PKPushType) {
        let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
        notifyListeners("voipTokenReceived", data: ["token": token])
    }

    public func pushRegistry(_ registry: PKPushRegistry,
                             didReceiveIncomingPushWith payload: PKPushPayload,
                             for type: PKPushType,
                             completion: @escaping () -> Void) {
        // Apple REQUIRES that we report a CallKit incoming call here, on the
        // same run-loop tick, before completion(). Otherwise the OS bans the
        // app from receiving future VoIP pushes.
        let dict = payload.dictionaryPayload
        let callId = dict["call_id"] as? String ?? UUID().uuidString
        let callerName = dict["sender_display_name"] as? String ?? "Unknown"
        let roomId = dict["room_id"] as? String ?? ""
        let hasVideo = (dict["msg_type"] as? String) == "m.call.invite.video"

        // Forward to IncomingCallKit (or call CXProvider directly here).
        // We fan out via NotificationCenter so the IncomingCallKit plugin
        // picks it up; this avoids cross-plugin direct dependencies.
        NotificationCenter.default.post(
            name: NSNotification.Name("forta.voip.incoming"),
            object: nil,
            userInfo: ["callId": callId, "callerName": callerName, "roomId": roomId, "hasVideo": hasVideo]
        )

        // Also surface to JS for telemetry/bug-reports.
        notifyListeners("voipPushReceived", data: [
            "callId": callId, "roomId": roomId, "callerName": callerName, "hasVideo": hasVideo,
        ])

        completion()
    }

    @objc func getToken(_ call: CAPPluginCall) {
        if let data = registry.pushToken(for: .voIP) {
            let token = data.map { String(format: "%02x", $0) }.joined()
            call.resolve(["token": token])
        } else {
            call.resolve(["token": NSNull()])
        }
    }
}
```

`.m` file: standard `CAP_PLUGIN(IOSVoIPPushPlugin, "IOSVoIPPush", CAP_PLUGIN_METHOD(getToken, CAPPluginReturnPromise);)`.

**Step 2: TS bridge**

`src/shared/lib/push/ios-voip-push.ts`:

```typescript
import { registerPlugin } from '@capacitor/core';
interface IOSVoIPPushPlugin {
  getToken(): Promise<{ token: string | null }>;
  addListener(ev: 'voipTokenReceived' | 'voipPushReceived',
              cb: (data: { token?: string; callId?: string; ... }) => void
              ): Promise<{ remove: () => void }>;
}
export const IOSVoIPPush = registerPlugin<IOSVoIPPushPlugin>('IOSVoIPPush');
```

**Step 3: Wire into push-service.ts**

In `src/shared/lib/push/push-service.ts`, add an `isIOS` branch in `init()` that:

1. Calls `IOSVoIPPush.getToken()` (and listens to `voipTokenReceived` for refresh).
2. Registers a **second** Matrix pusher with `app_id: 'fortaios.voip'`, `pushkey: voipToken`, separate from the regular APNs pusher (so Sygnal knows to send VoIP-class APNs for `m.call.invite` only).
3. Cleans stale pushers same as Android.

The **regular** APNs pusher (`app_id: 'fortaios'`) is created by Task 4 of `2026-05-12-ios-apns-push.md`.

**Step 4: Verify**

```
npm run build && npx cap sync ios && cd ios && xcodebuild -workspace App.xcworkspace -scheme App -configuration Debug
```

Expected: build succeeds. Smoke-test on a real device (PushKit requires real APNs).

**Step 5: Commit**

```
git add ios/App/App/IOSVoIPPushPlugin.swift ios/App/App/IOSVoIPPushPlugin.m src/shared/lib/push/ios-voip-push.ts src/shared/lib/push/push-service.ts
git commit -m "feat(ios): IOSVoIPPush plugin and Matrix VoIP pusher registration"
```

---

### Task 4: Custom `IOSCallAudio` Capacitor plugin

**Files (new):**
- `ios/App/App/IOSCallAudioPlugin.swift`
- `ios/App/App/IOSCallAudioPlugin.m`

**Why:** WKWebView's WebRTC works in foreground but its mic is muted in background. CallKit needs an active `AVAudioSession` with category `.playAndRecord` and mode `.voiceChat` so the OS keeps audio alive while the call is in progress. We wire `IOSCallAudio.start()` to be called from JS at `reportCallConnected` (same hook Android uses for `startAudioRouting`).

**Step 1: Swift implementation (~80 LOC)**

```swift
import Capacitor
import AVFoundation

@objc(IOSCallAudioPlugin)
public class IOSCallAudioPlugin: CAPPlugin {
    @objc func start(_ call: CAPPluginCall) {
        let isVideo = call.getString("callType") == "video"
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(
                .playAndRecord,
                mode: isVideo ? .videoChat : .voiceChat,
                options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker]
            )
            try session.setActive(true, options: [.notifyOthersOnDeactivation])
            call.resolve()
        } catch {
            call.reject("AVAudioSession.setActive failed: \(error)")
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        } catch {
            // Best effort; logged.
            print("[IOSCallAudio] setActive(false) failed: \(error)")
        }
        call.resolve()
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        let session = AVAudioSession.sharedInstance()
        let inputs = session.currentRoute.inputs.map { $0.portType.rawValue }
        let outputs = session.currentRoute.outputs.map { $0.portType.rawValue }
        let isSpeakerOn = outputs.contains(AVAudioSession.Port.builtInSpeaker.rawValue)
        let isBtScoOn  = outputs.contains(AVAudioSession.Port.bluetoothHFP.rawValue)
        let mode = (session.category == .playAndRecord) ? "MODE_IN_COMMUNICATION" : "MODE_NORMAL"
        call.resolve(["mode": mode, "isSpeakerOn": isSpeakerOn, "isBtScoOn": isBtScoOn,
                      "inputs": inputs, "outputs": outputs])
    }

    @objc func setOutput(_ call: CAPPluginCall) {
        guard let target = call.getString("device") else { call.reject("device required"); return }
        let session = AVAudioSession.sharedInstance()
        do {
            switch target {
            case "speaker": try session.overrideOutputAudioPort(.speaker)
            case "earpiece", "default": try session.overrideOutputAudioPort(.none)
            default: break
            }
            call.resolve()
        } catch {
            call.reject("overrideOutputAudioPort failed: \(error)")
        }
    }
}
```

**Step 2: Wire into JS adapter**

In `src/shared/lib/native-calls/native-call-bridge.ts`, when `isIOS`, replace the Android-side `NativeCall.startAudioRouting/stopAudioRouting/forceStopAudio/getAudioStatus` with `IOSCallAudio.start/stop/stop/getStatus`.

**Step 3: Verify**

Build, run on real device, place a voice call, lock screen mid-call. Expected: audio continues until hangup. Without this plugin, audio drops within ~1s of backgrounding.

**Step 4: Commit**

```
git add ios/App/App/IOSCallAudioPlugin.swift ios/App/App/IOSCallAudioPlugin.m
git commit -m "feat(ios): IOSCallAudio plugin for AVAudioSession setup"
```

---

### Task 5: Cold-start Accept handling

**Why:** On Android, `CallConnection.pendingAnswerCallId` is the static buffer that `nativeCallBridge.consumePendingAnswerCallId()` reads when JS comes alive after the user tapped Accept on the lock screen. iOS `@capgo/capacitor-incoming-call-kit` already provides `getPendingAnswer()` / `getPendingReject()` with the same semantics (per its docs). The Task 2 wrapper already routes to it.

**Step 1: Verify the existing recovery path**

`waitForMatrixCallAndAnswer` in `native-call-bridge.ts:340-408` polls `callStore.matrixCall` and feeds missed `m.call.invite` events back into the SDK. This path is platform-agnostic — no change needed.

**Step 2: Manual test**

1. Force-quit app.
2. Have a partner call you.
3. Tap Accept on the CallKit ringer (app starts cold).
4. Within 30s, Matrix /sync delivers the invite, `waitForMatrixCallAndAnswer` matches by `callId` or `roomId`, calls `answerCall()`. Audio should connect.

If the 30s window expires consistently in production, increase `MAX_WAIT_MS` and consider a Bastyon-side optimization to deliver the `m.call.invite` event_id inside the VoIP push payload's `room_id`.

---

### Task 6: AVAudioSession interruption handling

**Files:**
- Add to: `ios/App/App/IOSCallAudioPlugin.swift`

**Why:** When a real phone call comes in mid-VoIP-call, iOS sends `AVAudioSession.interruptionNotification`. We need to gracefully end our call (CallKit will already pause audio).

**Step 1: Subscribe in plugin's `load()`**

```swift
override public func load() {
    NotificationCenter.default.addObserver(
        self, selector: #selector(handleInterruption(_:)),
        name: AVAudioSession.interruptionNotification, object: nil
    )
}
@objc func handleInterruption(_ notification: Notification) {
    guard let info = notification.userInfo,
          let typeValue = info[AVAudioSessionInterruptionTypeKey] as? UInt,
          let type = AVAudioSession.InterruptionType(rawValue: typeValue) else { return }
    switch type {
    case .began:  notifyListeners("audioInterruptionBegan", data: [:])
    case .ended:  notifyListeners("audioInterruptionEnded", data: [:])
    @unknown default: break
    }
}
```

**Step 2: JS-side reaction**

In `audio-watchdog.ts`, add an iOS branch that listens to `audioInterruptionBegan` and triggers `callService.hangup()` for active calls (mirroring the Android stuck-mode watchdog).

**Step 3: Commit**

```
git add ios/App/App/IOSCallAudioPlugin.swift src/features/video-calls/model/audio-watchdog.ts
git commit -m "feat(ios): handle AVAudioSession interruptions during calls"
```

---

### Task 7: Stub `InviteThrottleTracker` on iOS

**Why:** `getInviteThrottleSnapshot` is bug-report telemetry from the Android FCM service. iOS push semantics are different (PushKit is real-time, no throttling), so the metric is meaningless. JS already gracefully handles the "method not registered" case (`native-call-bridge.ts:666-676`); make it explicit on iOS by returning empty without making a native call.

**Step 1: Edit `getInviteThrottleSnapshot`**

```typescript
async getInviteThrottleSnapshot(): Promise<InviteThrottleSnapshot> {
  if (!isAndroid) return { records: [] }; // iOS uses PushKit, no FCM throttling
  ...
}
```

**Step 2: Update bug-report copy** in `src/shared/lib/bug-report/collect-call-diagnostics.ts` to skip the throttle section on iOS.

**Step 3: Commit**

```
git add src/shared/lib/native-calls/native-call-bridge.ts src/shared/lib/bug-report/collect-call-diagnostics.ts
git commit -m "chore(ios): skip Android-only FCM invite throttle in bug reports"
```

---

## Verification gate (end of plan)

- [ ] `npm run build` — green.
- [ ] `npx vitest run` — green.
- [ ] `cd ios && xcodebuild -workspace App.xcworkspace -scheme App -configuration Release` — succeeds.
- [ ] Real-device manual matrix:
  - [ ] Outgoing call (voice): rings partner, audio bidirectional.
  - [ ] Outgoing call (video): video bidirectional, switch camera works.
  - [ ] Incoming call while app open: CallKit sheet, Accept connects.
  - [ ] Incoming call while app backgrounded: CallKit sheet on lock screen, Accept connects.
  - [ ] **Incoming call cold-start:** force-quit, partner calls, tap Accept on lock screen — audio connects within 30s.
  - [ ] Background mid-call: audio continues for ≥30s, returns to foreground works.
  - [ ] Hang up locally: peer's call ends within 5s.
  - [ ] Real phone call interrupts our call: our call ends cleanly, phone call uninterrupted.
  - [ ] Decline incoming call: peer's UI returns to "Call rejected" within 5s.
  - [ ] Bluetooth headset connect mid-call: audio routes through headset.

## Out of scope (v1)

- Audio device picker UI (use system AVAudioSession picker / control center; revisit if users complain).
- Group calls (matrix-js-sdk-bastyon doesn't support them yet).
- Screen sharing (`getDisplayMedia` works in iOS 17 but UI/UX is a separate spec).
- CallKit history integration (calls show in Recent Calls — nice-to-have, not v1).

