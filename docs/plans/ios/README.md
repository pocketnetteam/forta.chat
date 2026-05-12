# iOS Platform — Getting Started

> **Where to start adding iOS support to Forta Chat.** This document is the entry point for any contributor picking up iOS work. Read it once, then follow the linked plans in order. Detailed task lists, code snippets, and verification gates live in the per-area plans.

**Audience:** developer (or AI agent) about to start the iOS port. Assumes familiarity with the existing Android Capacitor setup (`docs/android-local-build.md`) and the FSD project structure.

**Project decision baseline (do not relitigate inside plans):**
1. **Tor is not shipped on iOS** — JS-stubs only.
2. **Native WebRTC engine is not shipped on iOS** — WKWebView's built-in WebRTC is used. See `2026-05-12-ios-webrtc-decision.md` for why.
3. **Plugin-first** — for every Android Kotlin plugin we look for a Capacitor/community plugin before writing Swift.
4. **Apple ToS is non-negotiable** — self-update, full-screen ringer outside CallKit, side-loading prompts → all hidden, not re-implemented.

---

## Plan index

| # | Plan | Area | Effort |
|---|---|---|---|
| 0 | [`2026-05-12-ios-overall-plan.md`](./2026-05-12-ios-overall-plan.md) | Roadmap, phases, plugin matrix, risks | reading |
| 1 | [`2026-05-12-ios-simple-tasks.md`](./2026-05-12-ios-simple-tasks.md) | Bootstrap, bundle id, icons, JS-stubs, telemetry, banners | ~1 week |
| 2 | [`2026-05-12-ios-keyboard-safe-area.md`](./2026-05-12-ios-keyboard-safe-area.md) | `@capacitor/keyboard` + `env(safe-area-inset-*)` + status bar | ~3 days |
| 3 | [`2026-05-12-ios-apns-push.md`](./2026-05-12-ios-apns-push.md) | APNs, Firebase iOS SDK, Notification Service Extension | ~1.5 weeks |
| 4 | [`2026-05-12-ios-webrtc-decision.md`](./2026-05-12-ios-webrtc-decision.md) | Skip native WebRTC engine, gate JS proxy to Android | ~2 days |
| 5 | [`2026-05-12-ios-callkit-pushkit.md`](./2026-05-12-ios-callkit-pushkit.md) | CallKit ringer, PushKit, AVAudioSession, cold-start Accept | ~3–5 weeks |
| 6 | [`2026-05-12-ios-share-extension.md`](./2026-05-12-ios-share-extension.md) | Share Extension target + App Group | ~1 week |
| 7 | [`2026-05-12-ios-universal-links.md`](./2026-05-12-ios-universal-links.md) | AASA + Associated Domains | ~3 days |
| 8 | [`2026-05-12-ios-tor-file-stub.md`](./2026-05-12-ios-tor-file-stub.md) | `URLSession`-based file transfer (no Tor) | ~3 days |

**Total:** ~6–8 working weeks for a single developer following the recommended order, ~4–6 weeks for a pair working in parallel after Phase 0.

---

## Step-by-step process

### Step 0 — Read the roadmap

Open and read [`2026-05-12-ios-overall-plan.md`](./2026-05-12-ios-overall-plan.md) end-to-end. It defines:
- driving principles,
- the full plugin matrix (what's "free", what's custom Swift),
- phase order with dependency reasoning,
- risk register (background mic, App Store rules, Sygnal config),
- definition-of-done.

Do not skip to a sub-plan without internalising the roadmap — sub-plans assume the conventions and decisions there.

---

### Step 1 — One-time external setup (do this BEFORE any code)

These cannot be done from CI; they require human action in external tools. Block out a half-day of hands-on work plus 1–3 days of waiting for Apple Developer enrollment approval.

**Authoritative sub-documents** (read in this order, then execute):

| File | Purpose |
|---|---|
| [`STEP-1-CHECKLIST.md`](./STEP-1-CHECKLIST.md) | The canonical task checklist for Step 1. Sections A–H map to enrollment, App ID, App Group, APNs `.p8`, Firebase, AASA, Sygnal, App Store Connect. Tick boxes as you complete them. |
| [`SECRETS-MANIFEST.md`](./SECRETS-MANIFEST.md) | What is secret vs confidential vs public, where each artefact lives, who has access. **Read before touching the `.p8` or `GoogleService-Info.plist`.** |
| [`aasa-template.json`](./aasa-template.json) | Ready-to-deploy AASA JSON with `<TEAM_ID>` placeholder. Hand to web team. |
| [`aasa-DEPLOYMENT.md`](./aasa-DEPLOYMENT.md) | Deployment instructions for the web team (HTTP requirements, web-server config snippets, copy-paste cover note). |
| [`SYGNAL-CONFIG-REQUEST.md`](./SYGNAL-CONFIG-REQUEST.md) | Configuration request for the homeserver/Sygnal admin team — two pushers (`fortaios`, `fortaios.voip`) with payload schemas + Apple constraints + copy-paste email body. |

**Quick summary** (canonical list lives in `STEP-1-CHECKLIST.md`; do not duplicate decisions here):

1. **macOS + Xcode 16+** on a machine you can keep around for the duration of the port. iOS builds *cannot* run on Windows or Linux.
2. **Apple Developer Program** — see `STEP-1-CHECKLIST.md` Section A.
3. **App ID** `com.forta.chat` — see `STEP-1-CHECKLIST.md` Section B.
4. **App Group** `group.com.forta.chat` — see `STEP-1-CHECKLIST.md` Section C.
5. **APNs Auth Key (`.p8`)** — see `STEP-1-CHECKLIST.md` Section D + `SECRETS-MANIFEST.md` "A. APNs Auth Key".
6. **Firebase iOS app** in the same project as Android — see `STEP-1-CHECKLIST.md` Section E + `SECRETS-MANIFEST.md` "D. Firebase iOS".
7. **Apple App Site Association (AASA)** — hand `aasa-template.json` + `aasa-DEPLOYMENT.md` to the web team. Format spec also in [`2026-05-12-ios-universal-links.md`](./2026-05-12-ios-universal-links.md) Task 1.
8. **Sygnal pushers** (`fortaios`, `fortaios.voip`) — hand `SYGNAL-CONFIG-REQUEST.md` to the homeserver admin.
9. **App Store Connect listing** — see `STEP-1-CHECKLIST.md` Section H. Minimal listing only — full metadata waits until Step 10.

Output of this step (a.k.a. "what `STEP-1-CHECKLIST.md` "Final pre-Step-2 verification" verifies):
- `.p8` APNs key in 1Password, never on disk.
- `GoogleService-Info.plist` staged in 1Password (or `tmp/`), ready to drop into `ios/App/App/` once Step 2 creates that folder.
- AASA file live at `forta.chat` and `www.forta.chat`, returns 200 + `application/json`, verified with `swcutil dl -d forta.chat` (when a Mac is available).
- Sygnal `app_id: fortaios` and `app_id: fortaios.voip` configured.
- Recorded placeholders: `<TEAM_ID>`, `<APNS_KEY_ID>`, `<APP_STORE_ID>`.

---

### Step 2 — Phase 0: Bootstrap (Plan 1, partial)

Goal: empty iOS shell builds and runs the Vue app.

1. Follow [`2026-05-12-ios-simple-tasks.md`](./2026-05-12-ios-simple-tasks.md) **Tasks 1, 2, 3, 9** in order.
   - Task 1 → `npx cap add ios`
   - Task 2 → bundle id, signing team
   - Task 3 → app icon + splash
   - Task 9 → `capacitor.config.ts` consolidated config
2. Open `ios/App/App.xcworkspace`, run on iOS 17 simulator.
3. App should boot, show splash, hit login screen. **Stop here — do not proceed until this works.**

Verification: simulator launches the existing Vue web app inside WKWebView. Login screen renders. No errors in Xcode console beyond unrelated Capacitor info logs.

---

### Step 3 — Phase 1: UI parity (Plans 1 + 2)

Goal: app functions for text-only chats; no calls, no push, no Tor.

1. Finish remaining tasks in [`2026-05-12-ios-simple-tasks.md`](./2026-05-12-ios-simple-tasks.md): **Tasks 4–8, 10, 11**.
   - Task 4 → Tor JS-stubs (just stub, per project decision)
   - Task 5 → Locale stub
   - Task 6 → AppUpdater hide (already gated by `isAndroid`)
   - Task 7 → telemetry iOS branch
   - Task 8 → App Store banner for Safari users
2. Execute [`2026-05-12-ios-keyboard-safe-area.md`](./2026-05-12-ios-keyboard-safe-area.md) end-to-end.
3. Manual test on real device:
   - Login works.
   - Chat list loads from Matrix sync.
   - Open chat, send text, send emoji, send 1 image (uses WKWebView's built-in `getUserMedia` → no, that's calls; image upload uses `@capacitor/camera` + `fetch` to homeserver — confirm both work).
   - Keyboard slides correctly, composer sits above it, no white gap.
   - Theme toggle flips status bar.

Verification: a complete text-chat workflow works on iOS without push or calls. Tor toggle absent in Settings, AppUpdater button absent.

---

### Step 4 — Phase 2: Push (silent — no NSE yet) (Plan 3, partial)

Goal: device receives a notification when a chat message arrives in a backgrounded app. Body shows "New message" placeholder; tap opens the right chat.

1. Execute [`2026-05-12-ios-apns-push.md`](./2026-05-12-ios-apns-push.md) **Tasks 1–2, 5–6** (skip Tasks 3 and 4 = NSE for now).
2. Real-device test (push **does not work on simulator**):
   - Have a partner send you a message while app is backgrounded.
   - Notification arrives within 5s.
   - Tap → app opens to the right room.
3. Open Matrix `getPushers()` and confirm an entry with `app_id: 'fortaios'` exists.

Verification: push delivery works end-to-end. Notification body is generic ("New message") — that's fine, NSE comes in Step 8.

---

### Step 5 — Phase 3: WebRTC decision (Plan 4)

Goal: confirm WKWebView WebRTC works for our calls before sinking weeks into CallKit infrastructure.

1. Execute [`2026-05-12-ios-webrtc-decision.md`](./2026-05-12-ios-webrtc-decision.md) **Tasks 1–4**.
2. **Critical smoke test (Task 4):** place a call between iOS device and Android device.
   - Voice call: foreground works, audio bidirectional.
   - Video call: video both directions.
   - Background mid-call: audio drops within ~1s. **This is expected** — fixed in Phase 4 by CallKit + AVAudioSession.
3. **If foreground calls do not work** — abort the WKWebView path, escalate to "Plan B" (integrate `WebRTC.xcframework`). Plan B is documented in `2026-05-12-ios-webrtc-decision.md`. Adds ~3 weeks. Notify the team.

Verification: calls between iOS and Android complete in foreground. The native WebRTC proxy installs only on Android (verified via `vitest`).

---

### Step 6 — Phase 4: CallKit + PushKit (Plan 5)

This is the largest single sub-plan. Goal: incoming calls ring via CallKit on the lock screen, accept-from-lock works, audio survives backgrounding.

1. Execute [`2026-05-12-ios-callkit-pushkit.md`](./2026-05-12-ios-callkit-pushkit.md) **Tasks 1–7** in order.
   - Task 1 → install `@capgo/capacitor-incoming-call-kit`
   - Task 2 → wrap behind existing `nativeCallBridge` (zero-touch for callers)
   - Task 3 → custom `IOSVoIPPush` plugin (~150 LOC Swift)
   - Task 4 → custom `IOSCallAudio` plugin (~80 LOC Swift)
   - Task 5 → cold-start Accept buffering (mostly already handled by `waitForMatrixCallAndAnswer`)
   - Task 6 → AVAudioSession interruption handling
   - Task 7 → stub `InviteThrottleTracker` (Android-only telemetry)
2. Real-device matrix at the end of the plan covers 10 scenarios (incoming/outgoing × foreground/background/cold-start, bluetooth handover, real-phone-call interruption, etc.). All must pass.

Verification: lock-screen ringer works, Accept on lock screen connects audio, mid-call backgrounding does not drop audio. Two pushers in `getPushers()`: `fortaios` (regular) and `fortaios.voip` (PushKit).

---

### Step 7 — Phase 5: Notification Service Extension (Plan 3, completion)

Goal: instead of "New message", the user sees the actual sender name and decrypted body in push notifications (for non-encrypted rooms; encrypted rooms still show placeholder until a separate v2 ticket lands Olm-in-Swift).

1. Execute [`2026-05-12-ios-apns-push.md`](./2026-05-12-ios-apns-push.md) **Task 3** (NSE target).
2. Skip **Task 4** for v1 (E2E decryption in NSE — deferred). Open the issue noted in the plan for v2.
3. Verify on a real device:
   - Plain (non-E2E) message arrives → notification shows room name + sender + body.
   - E2E message arrives → notification shows "New message" placeholder. (Acceptable for v1.)
   - `m.call.hangup` push correctly removes the prior `m.call.invite` notification.

Verification: NSE rewrites `bestAttemptContent` correctly. App Group is correctly shared between main app and NSE.

---

### Step 8 — Phase 6: Share Extension + Universal Links (Plans 6 + 7, parallel)

These two are independent and can be done in parallel by two developers.

#### Share Extension

1. Execute [`2026-05-12-ios-share-extension.md`](./2026-05-12-ios-share-extension.md) **Tasks 1–4**.
2. Test: share text/image/video from Photos / Notes / Safari → ForwardPicker opens.

#### Universal Links

1. Execute [`2026-05-12-ios-universal-links.md`](./2026-05-12-ios-universal-links.md) **Tasks 1–5**.
2. Test: tap `https://forta.chat/invite/abc123` in Safari → app opens directly to invite screen.

Verification: both flows match Android's behavior 1:1.

---

### Step 9 — Phase 7: TorFile fallback (Plan 8)

Goal: large file uploads/downloads with progress, without requiring Tor.

1. Execute [`2026-05-12-ios-tor-file-stub.md`](./2026-05-12-ios-tor-file-stub.md) **Tasks 1–2**.
2. Skip Task 3 (background `URLSession` — deferred to v2).
3. Verify the 6-step real-device matrix at the end of the plan.

Verification: 100 MB file uploads with smooth progress bar, no OOM.

---

### Step 10 — Phase 8: Polish + App Store submission

Not a separate plan — distributed across the others. Pre-submission checklist:

1. **App Privacy questionnaire** in App Store Connect:
   - Microphone (calls, voice messages) — "App functionality"
   - Camera (calls, photo capture) — "App functionality"
   - Contacts — **NOT used** (Forta Chat doesn't read system contacts)
   - User content stored on device + (optionally) in encrypted Matrix homeserver
   - **Do not declare Tor** — we do not ship it on iOS
   - **Do not declare crash reporting** unless we add it explicitly
2. **App Privacy URL** — point at the existing `https://forta.chat/privacy.html` (or hostname equivalent).
3. **Export Compliance** — Forta Chat uses E2E crypto (matrix-js-sdk-bastyon). Mark "Yes, uses encryption" → "Exempt" if it qualifies (open-source, end-user crypto, etc.) — consult Apple docs and a lawyer if uncertain.
4. **Screenshots** — 6.7" (iPhone 15 Pro Max), 6.5" (older Pro Max), 5.5" (iPhone 8 Plus, **required by App Store as of 2024**), 12.9" (iPad Pro). Five screenshots each, no marketing text overlay.
5. **TestFlight beta** — invite the team + 5–10 trusted external testers for at least 1 week before submitting for review.
6. **Review notes** — anticipate Apple reviewer questions about VoIP push usage:
   > "PushKit VoIP push is used exclusively for delivering Matrix `m.call.invite` events. The app reports a CallKit incoming call within ~50ms of receiving the push, well inside Apple's required window. Non-call pushes go through standard APNs (Notification Service Extension)."
7. Upload the build via Xcode Archive → Distribute. First review cycle typically takes 24–48 hours.

Verification: App Store Connect → app status changes to "Ready for Sale" or "In Review".

---

## Working agreements during the port

- **Worktree per plan.** Per the project rule (`CLAUDE.md` → "Git Worktree Isolation"), every sub-plan is implemented in its own git worktree to avoid step-on-toes between parallel sessions.
- **Conventional Commits** — same as Android. Prefer `feat(ios): ...` to make `git log --grep "ios"` clean.
- **No skipping verification gates** — each sub-plan ends with `npm run build`, `npx vitest run`, `xcodebuild -workspace ...`, plus a real-device manual matrix. All three must be green before moving to the next plan.
- **Tests follow code** — every Vue/TS change ships with co-located `*.test.ts`. Swift code without unit tests is acceptable for v1 (CI-running iOS tests is a separate effort), but every Swift plugin should have a paragraph in its plan describing the manual test.
- **No Tor on iOS** is a hard rule. If a plan ever says "wait, what if we add Tor on iOS?" — abort, that's out of scope.
- **No native WebRTC** is a hard rule unless Phase 3 smoke-tests it as broken. If you hit it, the escalation is documented inside `2026-05-12-ios-webrtc-decision.md` "Plan B".

---

## "I'm stuck" decision tree

| Symptom | First thing to check | Plan reference |
|---|---|---|
| Login works but Matrix sync hangs | Is Tor accidentally being called on iOS? Confirm `TorService.init` no-ops via `isIOS` check. | `simple-tasks.md` Task 4 |
| Push token never arrives | Real device? `aps-environment` entitlement set? `GoogleService-Info.plist` for the right bundle id? | `apns-push.md` Task 1 |
| Push arrives but tap does nothing | `IOSPushIntent` plugin's `UNUserNotificationCenter.delegate` race with Capacitor — make sure `IOSPushIntent.load()` runs before `UIApplicationDelegate.didFinishLaunching` returns. | `apns-push.md` Task 5 |
| CallKit ringer never appears | Is the VoIP push payload reaching `IOSVoIPPush.didReceiveIncomingPushWith`? Check device console for "PushKit". | `callkit-pushkit.md` Task 3 |
| Audio drops 1s after backgrounding mid-call | `AVAudioSession` not configured. Confirm `IOSCallAudio.start({callType:"voice"})` is called from `reportCallConnected`. | `callkit-pushkit.md` Task 4 |
| Universal Link opens Safari instead of app | AASA file not served as `application/json` or AppID/TeamID mismatch. Run `swcutil dl -d forta.chat`. | `universal-links.md` Task 1 |
| Share Extension hangs after tap | `appGroupId` mismatch between extension and main app, or App Group entitlement missing on one of them. | `share-extension.md` Task 2 |
| File upload works for small files but OOMs for large | Reverted to `fetch`-in-WebView path — confirm `IOSTorFile` plugin is registered and `TorFile.upload` is being called. | `tor-file-stub.md` Task 1 |

---

## Where to ask for help

- **Apple-side** — Apple Developer Forums (PushKit, CallKit, App Review tags).
- **Capacitor** — `https://github.com/ionic-team/capacitor` issues and Discord.
- **Capgo plugins** — each plugin has a Discord invite in its README; maintainer responds within 1–2 days.
- **Internal** — code review skills (`.claude/skills/review-team/SKILL.md`) before each PR.

