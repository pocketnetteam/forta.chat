# iOS APNs Push + Notification Service Extension Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Parent plan:** `2026-05-12-ios-overall-plan.md`
**Companion plan:** `2026-05-12-ios-callkit-pushkit.md` (covers VoIP push for `m.call.invite` only)

**Goal:** Replace Android `FortaFirebaseMessagingService.kt` + `PushDataPlugin.kt` for **non-call** push notifications using APNs + Firebase iOS SDK + a Notification Service Extension (NSE). Keep the JS bridge (`PushData.*`, `pushService.*`) backward-compatible.

---

## Critical reassessment

### Plugin landscape

- **`@capacitor/push-notifications`** — already in `package.json`. Supports iOS APNs out of the box. **Use it.** It surfaces:
  - `register()` → triggers iOS APNs registration, fires `'registration'` event with the FCM token (when Firebase iOS SDK is also installed) or APNs token directly.
  - `'pushNotificationReceived'` event when a push arrives in foreground.
  - `'pushNotificationActionPerformed'` event for tap.

- **`@capacitor/local-notifications`** — already in `package.json`. iOS-supported. We use it for Android channels today; on iOS it maps to `UNUserNotificationCenter`. The "channels" concept doesn't exist (iOS uses categories/sound/groupId), but `LocalNotifications.createChannel` is a safe no-op on iOS.

### What the Android Kotlin actually does that we need on iOS

| Android responsibility | iOS approach |
|---|---|
| Receive data-only push, post a notification immediately | APNs `mutable-content: 1` + Notification Service Extension hooks `didReceive` and posts the modified notification |
| Cache room name + sender display name in SharedPreferences | App Group + UserDefaults shared between main app, NSE, Share Extension |
| Decrypt encrypted message body via Matrix SDK and replace notification | NSE runs Matrix decryption with shared crypto store, modifies `bestAttemptContent.body` before delivery |
| Buffer "tap-to-open room" intent across cold-start | `UNNotificationResponse.userInfo` + small Swift glue plugin that surfaces `getPendingIntent()` to JS |
| Forward push to JS via `PushData.pushReceived` event | iOS APNs in foreground → `@capacitor/push-notifications` `'pushNotificationReceived'` event already does this |
| Handle hangup/reject/select_answer cancel paths | NSE inspects `msg_type`, calls `UNUserNotificationCenter.removeDeliveredNotifications` for the matching event_id |

### Decision

- Keep Firebase iOS SDK (single Sygnal pusher: `kind: http`, `url: matrix.pocketnet.app/_matrix/push/v1/notify`, FCM-issued device token). Less Sygnal config churn.
- Use `@capacitor/push-notifications` as the JS surface — no custom plugin for the registration / foreground-receive parts.
- Write **one** new custom Capacitor plugin `IOSPushIntent` (~80 LOC Swift) that surfaces tap-to-open intents (the cold-start buffer that `PushData.getPendingIntent()` provides on Android).
- Write the **Notification Service Extension** as a separate Xcode target. This is the core iOS-specific work.
- `PushDataPlugin.replaceNotificationContent` on Android is a synchronous "edit the already-shown notification" call. On iOS this is **impossible** post-delivery — we instead inject decryption into the NSE so the user never sees the encrypted version. Restructure the JS path: on iOS, `tryDecryptAndReplace` becomes a no-op because the NSE already did the work.

---

## Tasks

### Task 1: Firebase iOS SDK + APNs registration via `@capacitor/push-notifications`

**Files:**
- Modify: `ios/App/Podfile` (after `cap add ios`)
- Modify: `ios/App/App/AppDelegate.swift`
- Add: `ios/App/App/GoogleService-Info.plist` (downloaded from Firebase console for iOS bundle `com.forta.chat`)
- Modify: `capacitor.config.ts` (no changes needed; just confirm)

**Step 1: Add Firebase pods**

In `ios/App/Podfile`, add:

```ruby
target 'App' do
  capacitor_pods
  pod 'Firebase/Messaging'
end
```

Then `cd ios/App && pod install`.

**Step 2: Initialize Firebase**

In `ios/App/App/AppDelegate.swift`:

```swift
import UIKit
import Capacitor
import FirebaseCore
import FirebaseMessaging

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate, MessagingDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        FirebaseApp.configure()
        Messaging.messaging().delegate = self
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    // Forward APNs token to FCM SDK
    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Messaging.messaging().apnsToken = deviceToken
        // Pass through to Capacitor too
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        // Forward FCM token to Capacitor's PushNotifications plugin
        NotificationCenter.default.post(
            name: Notification.Name("capacitorPushNotificationToken"),
            object: nil, userInfo: ["token": fcmToken ?? ""]
        )
    }
}
```

**Step 3: JS already calls `PushNotifications.register()`**

`pushService.init()` already calls `PushNotifications.register()`. With Firebase wired, the `'registration'` event will receive the FCM token (matching Android's behavior).

**Step 4: Pusher app_id branch**

In `pushService.registerPusher()`:

```typescript
import { isIOS } from '@/shared/lib/platform';
...
const appId = isIOS ? 'fortaios' : 'fortaandroid';
const deviceDisplayName = isIOS ? 'iOS' : 'Android';
await matrixClient.setPusher({
  pushkey: token,
  kind: 'http',
  app_id: appId,
  app_display_name: 'Forta Chat',
  device_display_name: deviceDisplayName,
  ...
});
```

Pusher cleanup loop already handles per-`app_id` stale removal — no change needed.

**Step 5: Verify**

- Build & run on real device (push tokens don't fire on simulator).
- Confirm Firebase console shows the device.
- Send a test push from Firebase console — notification appears.
- Check Matrix `getPushers()` returns one entry with `app_id: 'fortaios'`.

**Step 6: Commit**

```
git add ios/App/Podfile ios/App/App/AppDelegate.swift ios/App/App/GoogleService-Info.plist src/shared/lib/push/push-service.ts
git commit -m "feat(ios): Firebase iOS SDK + APNs registration + per-platform pusher app_id"
```

---

### Task 2: App Group + shared UserDefaults for room/sender name cache

**Files:**
- Modify: `ios/App/App/App.entitlements` (created by Xcode capability)
- Add: `ios/App/App/Shared/SharedDataStore.swift` (used by main app, NSE, Share Extension)

**Step 1: Enable App Group capability**

In Xcode: project → App target → Signing & Capabilities → + Capability → App Groups → Add `group.com.forta.chat`.

Repeat for the (yet-to-be-created) NSE target and Share Extension target later.

**Step 2: Shared store helper**

`SharedDataStore.swift`:

```swift
import Foundation
struct SharedDataStore {
    static let appGroup = "group.com.forta.chat"
    private static var defaults: UserDefaults { UserDefaults(suiteName: appGroup)! }

    static func cacheRoomName(_ roomId: String, _ name: String) {
        var dict = defaults.dictionary(forKey: "roomNames") as? [String: String] ?? [:]
        dict[roomId] = name
        defaults.set(dict, forKey: "roomNames")
    }
    static func roomName(_ roomId: String) -> String? {
        (defaults.dictionary(forKey: "roomNames") as? [String: String])?[roomId]
    }

    static func cacheSenderName(_ userId: String, _ name: String) {
        var dict = defaults.dictionary(forKey: "senderNames") as? [String: String] ?? [:]
        dict[userId] = name
        defaults.set(dict, forKey: "senderNames")
    }
    static func senderName(_ userId: String) -> String? {
        (defaults.dictionary(forKey: "senderNames") as? [String: String])?[userId]
    }
}
```

**Step 3: Bridge to JS**

The existing `PushData.cacheRoomNames` / `cacheSenderNames` calls from `pushService.syncRoomNamesToNative` need an iOS-side handler. Either:

(a) extend the custom `IOSPushIntent` plugin (Task 5) with `cacheRoomNames` / `cacheSenderNames` methods, **or**
(b) create a tiny new plugin `IOSPushData` mirroring the Android `PushDataPlugin` API.

**Decision: (a)** — fold into `IOSPushIntent` to keep one custom plugin.

**Step 4: Commit**

```
git add ios/App/App/App.entitlements ios/App/App/Shared/SharedDataStore.swift
git commit -m "feat(ios): App Group + SharedDataStore for cross-target name cache"
```

---

### Task 3: Notification Service Extension target

**Files:**
- Add (via Xcode): `ios/App/NotificationService/NotificationService.swift`
- Add (via Xcode): `ios/App/NotificationService/Info.plist`

**Step 1: Create the target**

In Xcode → File → New → Target → Notification Service Extension → name `NotificationService`.

This generates the boilerplate. Add the App Group capability (`group.com.forta.chat`) to the new target.

**Step 2: Implement `didReceive`**

```swift
import UserNotifications

class NotificationService: UNNotificationServiceExtension {
    var contentHandler: ((UNNotificationContent) -> Void)?
    var bestAttemptContent: UNMutableNotificationContent?

    override func didReceive(_ request: UNNotificationRequest,
                             withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        self.contentHandler = contentHandler
        bestAttemptContent = request.content.mutableCopy() as? UNMutableNotificationContent
        guard let content = bestAttemptContent else { contentHandler(request.content); return }

        let userInfo = content.userInfo
        guard let roomId = userInfo["room_id"] as? String else {
            contentHandler(content); return
        }
        let msgType = userInfo["msg_type"] as? String ?? ""
        let senderId = userInfo["sender"] as? String
        let providedSenderName = userInfo["sender_display_name"] as? String
        let providedRoomName = userInfo["room_name"] as? String

        // Cache for offline lookups
        if let r = providedRoomName { SharedDataStore.cacheRoomName(roomId, r) }
        if let id = senderId, let n = providedSenderName { SharedDataStore.cacheSenderName(id, n) }

        // Cancel paths
        if msgType == "m.call.hangup" || msgType == "m.call.reject" || msgType == "m.call.select_answer" {
            // Remove any prior incoming-call notification by call_id
            if let callId = userInfo["call_id"] as? String {
                UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [callId])
            }
            // Suppress this notification entirely
            contentHandler(UNMutableNotificationContent())
            return
        }

        // Title = room name (cached or provided), subtitle = sender display name (cached or provided)
        content.title = SharedDataStore.roomName(roomId) ?? providedRoomName ?? content.title
        let senderName = providedSenderName ?? (senderId.flatMap(SharedDataStore.senderName)) ?? content.subtitle
        content.subtitle = senderName

        // Body — best-effort. v1: show "New message" placeholder for encrypted bodies.
        // v2 (deferred): run Matrix decryption here using a SwiftMatrix port + shared crypto store.
        let plaintextBody = userInfo["content_body"] as? String
        let contentMsgtype = userInfo["content_msgtype"] as? String ?? "m.text"
        content.body = renderBody(msgtype: contentMsgtype, plaintext: plaintextBody)

        contentHandler(content)
    }

    override func serviceExtensionTimeWillExpire() {
        if let handler = contentHandler, let content = bestAttemptContent {
            handler(content)
        }
    }

    private func renderBody(msgtype: String, plaintext: String?) -> String {
        switch msgtype {
        case "m.image": return NSLocalizedString("Photo", comment: "")
        case "m.video": return NSLocalizedString("Video", comment: "")
        case "m.audio": return NSLocalizedString("Voice message", comment: "")
        case "m.file":  return NSLocalizedString("File", comment: "")
        default: return plaintext ?? NSLocalizedString("New message", comment: "")
        }
    }
}
```

**Step 3: Sygnal payload requirements**

The NSE only fires when APNs payload contains `mutable-content: 1`. Sygnal already sets this for iOS pushers (per Element iOS playbook). Verify with Matrix admin / Sygnal config.

Also, the payload must NOT include `body` in `aps.alert` for our cancel suppression trick to work — Sygnal puts encrypted preview in `aps.alert.loc-key`. Confirm in production.

**Step 4: Verify**

- Send `m.room.message` push from another device. NSE rewrites title to room name.
- Send `m.call.hangup` while a prior `m.call.invite` notification is shown. The invite disappears.

**Step 5: Commit**

```
git add ios/App/NotificationService/
git commit -m "feat(ios): Notification Service Extension for offline title/body rendering"
```

---

### Task 4: Decrypt-on-arrival in NSE (v2 — deferred)

**Why deferred:** running Matrix encryption in Swift requires either:
1. Porting parts of `matrix-js-sdk-bastyon` decryption to Swift (large), or
2. Sharing the encrypted IndexedDB / device keys via the App Group and having the main app pre-load them into a Swift-friendly format (still needs a Swift Olm wrapper).

For v1 we ship Task 3's static rendering. Most pushes from this homeserver already include the plaintext body when E2E is off (`content_body`). For E2E rooms the user sees "New message".

**Open the issue** when v1 ships:

```
Title: NSE: implement Olm decryption for E2E rooms
Body: Currently NSE shows "New message" for encrypted rooms. Add libolm-swift
      + shared session store to decrypt server-side push payloads in NSE.
      Requires App Group sync of room session keys, which the main app
      already maintains in IndexedDB.
```

---

### Task 5: `IOSPushIntent` custom plugin (tap-to-open + name cache write)

**Files (new):**
- `ios/App/App/IOSPushIntentPlugin.swift`
- `ios/App/App/IOSPushIntentPlugin.m`

**Step 1: Swift implementation (~120 LOC)**

```swift
import Capacitor
import UserNotifications

@objc(IOSPushIntentPlugin)
public class IOSPushIntentPlugin: CAPPlugin, UNUserNotificationCenterDelegate {
    private var pendingTap: [String: String]?

    override public func load() {
        UNUserNotificationCenter.current().delegate = self
    }

    public func userNotificationCenter(_ center: UNUserNotificationCenter,
                                       didReceive response: UNNotificationResponse,
                                       withCompletionHandler completionHandler: @escaping () -> Void) {
        let userInfo = response.notification.request.content.userInfo
        guard let roomId = userInfo["room_id"] as? String else { completionHandler(); return }
        let eventId = userInfo["event_id"] as? String
        let payload: [String: String] = [
            "roomId": roomId,
            "eventId": eventId ?? ""
        ]
        if hasListeners("pushOpenRoom") {
            notifyListeners("pushOpenRoom", data: payload)
        } else {
            // App not loaded yet — buffer for getPendingIntent
            pendingTap = payload
        }
        completionHandler()
    }

    @objc func getPendingIntent(_ call: CAPPluginCall) {
        let p = pendingTap ?? [:]
        pendingTap = nil
        call.resolve(["roomId": p["roomId"] ?? "", "eventId": p["eventId"] ?? ""])
    }

    @objc func cacheRoomNames(_ call: CAPPluginCall) {
        guard let rooms = call.getObject("rooms") as? [String: String] else { call.reject("rooms required"); return }
        for (id, name) in rooms { SharedDataStore.cacheRoomName(id, name) }
        call.resolve()
    }

    @objc func cacheSenderNames(_ call: CAPPluginCall) {
        guard let senders = call.getObject("senders") as? [String: String] else { call.reject("senders required"); return }
        for (id, name) in senders { SharedDataStore.cacheSenderName(id, name) }
        call.resolve()
    }

    @objc func cancelNotification(_ call: CAPPluginCall) {
        guard let roomId = call.getString("roomId") else { call.resolve(); return }
        UNUserNotificationCenter.current().getDeliveredNotifications { delivered in
            let toRemove = delivered.filter {
                ($0.request.content.userInfo["room_id"] as? String) == roomId
            }.map { $0.request.identifier }
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: toRemove)
            call.resolve()
        }
    }

    @objc func replaceNotificationContent(_ call: CAPPluginCall) {
        // No-op on iOS: NSE already wrote the final notification at delivery.
        // Kept for API parity with Android.
        call.resolve()
    }
}
```

**Step 2: Update JS bridge `PushData`**

In `src/shared/lib/push/push-data-plugin.ts` (or wherever the bridge is registered), the same plugin name (`PushData`) registers to a different native impl per platform — Capacitor handles this. Just make sure the `IOSPushIntentPlugin.m` registers under name `"PushData"`:

```objc
CAP_PLUGIN(IOSPushIntentPlugin, "PushData", ...)
```

This keeps the JS bridge identical (`PushData.replaceNotificationContent(...)` etc), no consumer changes.

**Step 3: Verify**

- Cold-start tap: kill app, send push, tap notification, app opens to the right room.
- Background tap: same.
- Foreground tap: same.

**Step 4: Commit**

```
git add ios/App/App/IOSPushIntentPlugin.swift ios/App/App/IOSPushIntentPlugin.m
git commit -m "feat(ios): IOSPushIntent plugin (tap intents + shared name cache)"
```

---

### Task 6: Skip `tryDecryptAndReplace` on iOS

**Files:**
- Modify: `src/shared/lib/push/push-service.ts:106-134`

**Step 1: Branch by platform**

```typescript
private async tryDecryptAndReplace(data: PushPayload): Promise<void> {
  const { isIOS } = await import('@/shared/lib/platform');
  if (isIOS) {
    // On iOS the Notification Service Extension already produced the final
    // user-facing notification at delivery time. Post-decryption replacement
    // is not possible (iOS does not allow editing already-shown notifications),
    // and unnecessary because NSE handles encrypted bodies.
    return;
  }
  // ... existing Android logic
}
```

**Step 2: Commit**

```
git add src/shared/lib/push/push-service.ts
git commit -m "chore(ios): skip JS-side push decryption (handled by NSE)"
```

---

## Verification gate (end of plan)

- [ ] `npm run build` — green.
- [ ] `npx vitest run src/shared/lib/push/` — green.
- [ ] Real-device matrix:
  - [ ] `m.room.message` push: title = room name (or sender if DM), body = message text or type-specific placeholder, tap opens room.
  - [ ] `m.call.invite` push triggers CallKit ringer (handled by `2026-05-12-ios-callkit-pushkit.md`, this plan does NOT change call paths).
  - [ ] Cold-start tap from notification: app opens to the right room within 5s.
  - [ ] `m.call.hangup` push removes the prior `m.call.invite` notification (test by tapping Decline on partner side).
  - [ ] Two devices logged into same account each receive their own notification, deduped via Matrix's pusher routing.

## Out of scope

- E2E room body decryption in NSE (Task 4 deferred — separate v2 issue).
- Rich notifications (image attachments, replies inline) — straightforward UNNotificationAttachment work, not v1.
- Notification grouping / threading per room (iOS does this automatically when `threadIdentifier = roomId` — set this in NSE, but no UX changes).

