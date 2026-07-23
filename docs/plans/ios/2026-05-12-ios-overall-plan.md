# iOS Platform — Overall Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to drive each linked sub-plan task-by-task. This is the *roadmap*; concrete steps live in the per-area plans.

**Goal:** Add iOS as a first-class platform for Forta Chat with feature-parity to Android **wherever Apple allows it**, using existing Capacitor plugins where possible and writing the minimum Swift glue otherwise.

**Driving principles:**

1. **Plugin-first.** Before writing Swift, look for a Capacitor/Capgo/community plugin that solves the problem and is on the same Capacitor major (8.x). Custom Swift only when no plugin exists.
2. **Critically reassess every Android-specific decision.** Android's `MainActivity` injects safe-area CSS vars manually because its WebView/OEM situation requires it. iOS WKWebView is one engine, controlled by Apple — most Android workarounds simply do not apply.
3. **No Tor on iOS** (per project decision). Plug a no-op stub so the JS layer keeps compiling, the rest of the app falls back to direct HTTPS to the homeserver.
4. **No native WebRTC engine on iOS.** WKWebView has shipped getUserMedia + RTCPeerConnection since iOS 14.3 — the JS proxy that swaps out `window.RTCPeerConnection` should simply not install on iOS. See `2026-05-12-ios-webrtc-decision.md`.
5. **Apple Store rules are non-negotiable.** Self-update, full-screen incoming-call activities outside CallKit, and arbitrary background work are forbidden. Affected features get hidden, not re-implemented.

## Tech baseline

- **Capacitor:** 8.2.0 (already installed) — `@capacitor/ios` 8.x.
- **Xcode:** 16+ (Swift 5.10), targeted at **iOS 15+** (matches WKWebView WebRTC, CallKit, App Group, Notification Service Extension stability). Older devices (iOS 14.x) are not supported.
- **macOS:** 14+ for Xcode 16. Required for the build pipeline.
- **Apple Developer Program:** $99/year. Required entitlements: Push Notifications, App Groups, Associated Domains, Background Modes (`voip`, `audio`, `remote-notification`).
- **APNs key** (`.p8`) in Apple Developer + Firebase project (we keep Firebase on iOS too — APNs delivery, FCM token surface stays the same as Android, single Matrix Sygnal pusher).

## Plugins we will add (all support iOS)

| Plugin | Purpose | Replaces on iOS |
|---|---|---|
| `@capacitor/ios` | Native runtime | — |
| `@capacitor/keyboard` | Keyboard show/hide events + height | Android-side `MainActivity` keyboard inset injection |
| `@capgo/capacitor-incoming-call-kit` | CallKit ringer (incoming UI, Decline/Accept callbacks) | `CallPlugin.kt` ringer surface |
| `@capacitor-community/callkit-voip-pushkit` *or* small custom Swift plugin | PushKit (VoIP push) registration + token | `FortaFirebaseMessagingService.kt` for `m.call.invite` |

Plugins that already work on iOS without changes (just `pod install`):
`@capacitor/app`, `@capacitor/camera`, `@capacitor/device`, `@capacitor/filesystem`, `@capacitor/haptics`, `@capacitor/local-notifications`, `@capacitor/network`, `@capacitor/push-notifications`, `@capacitor/share`, `@capacitor/status-bar`, `@capacitor-community/file-opener`, `@capgo/capacitor-share-target` (with manual Share Extension target).

Plugins explicitly **not** ported:
- `@capacitor-community/safe-area` — not needed; iOS WKWebView's `env(safe-area-inset-*)` already correct.
- `@capgo/capacitor-webview-version-checker` — iOS WebKit version is pinned to OS, telemetry collects `Build` instead.

## Custom plugins we will write

| Plugin (TS name) | Android | iOS approach | Plan |
|---|---|---|---|
| `Tor` | `TorPlugin.kt` | **No-op stub.** Returns `socksPort: 0`, `state: 'NEVER'`, `isReady: true`. | `2026-05-12-ios-simple-tasks.md` |
| `TorFile` | `TorFilePlugin.kt` | **Fallback to direct HTTPS** via `URLSession`. Tiny Swift plugin, ~100 lines. | `2026-05-12-ios-tor-file-stub.md` |
| `Locale` | `LocalePlugin.kt` | **Drop the plugin call on iOS** — iOS app picks language from `Bundle.main.preferredLocalizations`, hand-set via `Bundle.main.localizations` if user changes locale in-app (rare). Stub the JS bridge. | `2026-05-12-ios-simple-tasks.md` |
| `AppUpdater` | `UpdaterPlugin.kt` | **Hide UI on iOS.** Apple disallows side-loading. JS already gates by `isAndroid`. No iOS code needed. | `2026-05-12-ios-simple-tasks.md` |
| `PushData` | `PushDataPlugin.kt` | **Notification Service Extension** (separate Xcode target) for in-flight decryption, plus a thin Swift plugin that surfaces tap-to-open intents to JS. | `2026-05-12-ios-apns-push.md` |
| `NativeWebRTC` | `WebRTCPlugin.kt` | **Skip entirely.** Use WKWebView's built-in WebRTC. The JS proxy `installNativeWebRTCProxy()` is gated by `isNative` — change to `isAndroid && isNative`. | `2026-05-12-ios-webrtc-decision.md` |
| `NativeCall` | `CallPlugin.kt` | `@capgo/capacitor-incoming-call-kit` covers the UI surface; the audio-routing/probe methods are stubbed to "trust WKWebView and AVAudioSession". | `2026-05-12-ios-callkit-pushkit.md` |

## Sub-plans (work breakdown)

### Hard (≥ 3 weeks each)

- **`2026-05-12-ios-callkit-pushkit.md`** — CallKit ringer + PushKit (VoIP push) + AVAudioSession glue + cold-start Accept buffering, replacing Telecom/CallActivity/CallForegroundService.
- **`2026-05-12-ios-webrtc-decision.md`** — Decision plan: drop native WebRTC engine on iOS in favour of WKWebView's built-in. Includes the gating change, a small ICE watchdog audit, and explicit fallback plan if WKWebView turns out to misbehave under load.

### Medium (1–2 weeks each)

- **`2026-05-12-ios-apns-push.md`** — APNs + Firebase iOS SDK + Notification Service Extension for decryption-on-arrival, plus tap-to-open buffering and pusher registration changes.
- **`2026-05-12-ios-share-extension.md`** — Xcode Share Extension target wired to `@capgo/capacitor-share-target` via App Group + UserDefaults.
- **`2026-05-12-ios-universal-links.md`** — Apple App Site Association (AASA) + Associated Domains capability + parse pipeline reuse.
- **`2026-05-12-ios-keyboard-safe-area.md`** — Replace Android `MainActivity.injectAllCssVars` with `@capacitor/keyboard` events + native CSS `env(safe-area-inset-*)`. Status bar via `@capacitor/status-bar`.
- **`2026-05-12-ios-tor-file-stub.md`** — Fallback file transfer over `URLSession` (no Tor proxy) when `Tor` plugin reports `NEVER`. Same TS bridge surface, smaller Swift implementation.

### Simple (combined)

- **`2026-05-12-ios-simple-tasks.md`** — Tor JS-stubs, Locale drop, AppUpdater hide, telemetry iOS branch, banner copy, capacitor.config.ts changes, signing/identifiers, plugin pod install, app icon + splash assets, sanity test matrix.

## Suggested sequencing (recommended order)

```
Phase 0 – Bootstrap  (week 1)
  Apple dev account, certificates, App ID + entitlements,
  capacitor add ios, pod install, run empty app on simulator.
  → simple-tasks.md "bootstrap" section.

Phase 1 – Stubs + UI parity  (week 1–2)
  Tor stub, AppUpdater hide on iOS, Locale stub, telemetry
  branch, status bar, keyboard, safe-area: app boots, login
  works, chat works, sending text/image works.
  → simple-tasks.md + keyboard-safe-area.md.

Phase 2 – Push (silent)  (week 2–3)
  APNs registration, Firebase token, register Matrix pusher
  with app_id 'fortaios', tap-to-open buffering. No NSE
  yet — notifications show "Encrypted message".
  → apns-push.md tasks 1–4.

Phase 3 – WebRTC decision  (week 3)
  Gate the native proxy off on iOS. Place a 1-on-1 call in
  foreground from the simulator to verify WKWebView WebRTC
  works end-to-end. Decide: ship WKWebView path, or escalate
  to native WebRTC (Plan B in webrtc-decision.md).
  → webrtc-decision.md.

Phase 4 – CallKit + PushKit  (week 4–7)
  Ringer (incoming UI), PushKit registration + Sygnal pusher,
  cold-start Accept→answerCall queue, AVAudioSession setup,
  background mic limitation handling.
  → callkit-pushkit.md.

Phase 5 – Notification Service Extension  (week 7–8)
  Decrypt-on-arrival NSE target, App Group sync of crypto
  keys, replace native notification with decrypted body.
  → apns-push.md tasks 5–8.

Phase 6 – Share Extension + Universal Links  (week 8–9)
  Receive shared text/files from other apps; deep links via
  AASA file (paths /invite, /join).
  → share-extension.md, universal-links.md.

Phase 7 – TorFile fallback + audit  (week 9)
  Direct-fetch path for media uploads/downloads.
  → tor-file-stub.md.

Phase 8 – Polish + App Store submission  (week 10–12)
  App Store screenshots, App Privacy questionnaire (call,
  microphone, camera, contacts), TestFlight beta, review
  cycle, fix-ups.
```

## Cross-cutting infrastructure

- **`capacitor.config.ts` additions:**
  - Top-level `ios.contentInset: 'never'`, `ios.scrollEnabled: false` to mirror Android edge-to-edge.
  - Plugin configs for `Keyboard`, `CapacitorShareTarget` (appGroupId), `IncomingCallKit`.
- **App Groups** (`group.com.forta.chat`) — required to share data between main app, Share Extension, and Notification Service Extension.
- **Bundle ID** — `com.forta.chat` (matches Android applicationId for cross-platform consistency).
- **Firebase iOS app** — register `com.forta.chat` in the same Firebase project; Firebase issues an `APNs token → FCM token` mapping so our Sygnal pusher (`app_id: fortaios`, kind: `http`, url: same Sygnal URL) keeps using FCM-style http push notifications.
- **Pusher app_id** — change `pushService.registerPusher`'s hardcoded `'fortaandroid'` to a per-platform value: `isIOS ? 'fortaios' : 'fortaandroid'`. Both pushers can coexist on the same Matrix account (multi-device).
- **Background modes** declared in `Info.plist`:
  - `voip` — PushKit
  - `audio` — calls in background (with caveats, see callkit-pushkit.md)
  - `remote-notification` — APNs silent / NSE wake-up

## Verification gates

Each sub-plan ends with `npm run build`, `npx vue-tsc --noEmit`, `npx vitest run`, `cd ios && xcodebuild -workspace App.xcworkspace -scheme App -configuration Release` (CI step), and a manual checklist on a real device (simulator does not exercise CallKit + PushKit + camera fully).

## Risk register

| Risk | Mitigation |
|---|---|
| WKWebView WebRTC drops audio when app backgrounded mid-call | CallKit + AVAudioSession with `.playAndRecord, .voiceChat` keeps the audio session alive. See callkit-pushkit.md "Audio session" task. |
| Apple rejects PushKit usage for non-call pushes | Restrict PushKit to `m.call.invite` only; all other pushes go through standard APNs. |
| Apple rejects Tor stub binaries (none here) — false alarm | We *don't* ship Tor on iOS. Document this in App Privacy. |
| App Store rejects "self-update" mention | Hide all updater UI on iOS (already gated by `isAndroid`). |
| Firebase iOS SDK adds 5+ MB to binary | Acceptable; Element iOS does the same. Keep optional `Lite` variant on the table if size becomes a problem. |

## Definition of Done

- App boots on iOS 15+ device, logs in, syncs, sends/receives text and media.
- Incoming push wakes the app, shows decrypted preview within 5s.
- Voice/video call rings via CallKit, accepts from lock screen, audio works in foreground & after a brief background dip via CallKit's audio session.
- Universal Links open `/invite` and `/join` paths in the app.
- Sharing from Photos / Safari into the app routes through ForwardPicker.
- App Store TestFlight build passes review notes (no Tor mentioned in App Privacy, no self-update prompt).

