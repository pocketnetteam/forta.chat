# NotificationService (NSE) target

> **iOS Notification Service Extension** for Forta Chat. Mutates incoming
> APNs alerts on the device before they are shown, using the offline name
> cache shared via the `group.com.forta.chat` App Group.

## Files

- `NotificationService.swift` — extension entry point. Renders title / subtitle /
  body and suppresses `m.call.hangup` / `m.call.reject` / `m.call.select_answer`
  alerts. See the file header for the v1 / v2 scope split.
- `Info.plist` — declares the `NSExtension` point identifier
  (`com.apple.usernotifications.service`) and principal class.
- `NotificationService.entitlements` — `com.apple.security.application-groups`
  with `group.com.forta.chat`.

## One-time Xcode UI setup

The source files in this folder are committed to git, but the **Xcode target
must be created manually on a Mac** with Xcode 16+. Until that's done, the
files compile only by being added to another target — they will not produce
a `.appex` bundle.

Follow these steps in Xcode:

1. Open `ios/App/App.xcworkspace`.
2. **File → New → Target…**
3. Choose **iOS → Notification Service Extension**.
4. Settings:
   - Product Name: `NotificationService`
   - Team: same Apple Developer team as the main `App` target.
   - Organization Identifier: `com.forta` (so the bundle id becomes
     `com.forta.chat.NotificationService`).
   - Bundle Identifier: `com.forta.chat.NotificationService`.
   - Language: Swift.
   - Project: `App` (only option).
   - Embed in Application: `App`.
5. Click **Finish**. If Xcode asks to "Activate NotificationService scheme",
   say **Cancel** — we build it as a dependency of the `App` scheme.
6. Xcode generates a default `NotificationService.swift` and `Info.plist`
   inside `ios/App/NotificationService/` and adds them to the target. **Delete
   the generated stubs from disk and re-add the committed files in this
   folder** to the target via right-click → "Add Files to App…", making sure
   the only checkbox is the `NotificationService` target.
7. Select the `NotificationService` target → **Signing & Capabilities**:
   - Verify **App Groups** capability is present. If not: **+ Capability → App
     Groups**, then check `group.com.forta.chat`. (Same group the main `App`
     target already uses — main and NSE must agree.)
   - Confirm `Code Signing Entitlements` points at
     `NotificationService/NotificationService.entitlements`.
8. Add `ios/App/App/Shared/SharedDataStore.swift` to the
   `NotificationService` target membership: select the file in the project
   navigator → File Inspector → **Target Membership** → check
   **NotificationService** (leave **App** checked too — the main app still
   needs it). The NSE imports `SharedDataStore` from the same source file;
   it does not pull in the rest of the app.
9. Set the NSE's deployment target to **iOS 15.0** (matches the main app).
10. Build the `App` scheme. The NSE compiles as part of the main app build
    and is embedded into the `.app` bundle. Verify with:
    ```
    cd ios/App
    xcodebuild -workspace App.xcworkspace -scheme App -configuration Debug \
      -sdk iphonesimulator build
    ls -d build/Debug-iphonesimulator/App.app/PlugIns/NotificationService.appex
    ```
    The last command should list the embedded extension.

## Verifying delivery on a real device

NSE only fires when the APNs payload sets `mutable-content: 1`. Our Sygnal
config (`docs/plans/ios/SYGNAL-CONFIG-REQUEST.md`) requests this for the
`fortaios` pusher. Verify in two steps:

1. Send a test push from the Firebase console or via Sygnal with a payload
   containing `room_id`, `room_name`, `sender_display_name`, `msg_type =
   m.room.message`, `content_body = "hello"`. The banner should read:
   `room_name · sender_display_name · hello`.
2. While the banner from step 1 is on screen, send a second push with
   `msg_type = m.call.hangup` and the same `call_id` as a prior fake invite.
   The banner should be suppressed (no new notification appears).

If notifications still show the raw "New message" placeholder, the most
likely cause is the payload missing `mutable-content: 1` — check Sygnal's
delivery logs.

## What this target does NOT do

- Does **not** decrypt E2E room bodies. See
  `docs/plans/ios/2026-05-14-nse-e2e-decrypt-issue.md` for the v2 plan.
- Does **not** handle VoIP / `m.call.invite` pushes — those go through the
  separate `fortaios.voip` PushKit pusher and the `IOSVoIPPushPlugin` in the
  main app target.
- Does **not** post tap-to-open intents — that's the
  `IOSPushIntentPlugin`'s job in the main app.
