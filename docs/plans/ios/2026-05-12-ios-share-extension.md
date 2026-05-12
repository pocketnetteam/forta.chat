# iOS Share Extension Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Parent plan:** `2026-05-12-ios-overall-plan.md`
**Reuses:** `docs/plans/2026-04-09-android-share-target.md` (existing JS pipeline `share-target.ts`)

**Goal:** Make Forta Chat appear in iOS Share Sheet (text, links, images, video, files), routing the shared payload through the existing `share-target.ts` → ForwardPicker pipeline. Match Android behavior 1:1 from the user's POV.

---

## Critical reassessment

### Plugin landscape

`@capgo/capacitor-share-target` v8 supports iOS, but with a manual hand-off:

- The plugin gives you the **TS API** in the main app (`addListener('shareTargetReceived', ...)`, `getInitialShare()`).
- The plugin **does not** generate the iOS Share Extension target for you. Apple requires Share Extensions to be a separate Xcode target, with their own `Info.plist`, entitlements (App Group), and `ShareViewController.swift`.
- The Share Extension writes the shared payload into UserDefaults (under the agreed key `share-target-data` or `SharedData`) keyed by App Group ID, then closes itself with `extensionContext?.completeRequest`.
- The main app, when it next becomes active or when the plugin is queried, reads UserDefaults under that App Group, fires the JS event, then clears the entry.

So our work is:

1. Install the plugin (gives us the TS bridge + Android impl).
2. Create the Xcode Share Extension target with a thin `ShareViewController.swift` that writes to the shared UserDefaults.
3. Configure App Group on both the Share Extension and main app.
4. Configure plugin in `capacitor.config.ts`.
5. **Reuse the existing `share-target.ts` pipeline** — Android already does the same JS work; on iOS the same listener fires.

**Critical note:** there is a documented limitation in the plugin (Cap-go/capacitor-share-target#1) where the cold-launch path can drop the share. Mitigation: write the payload to UserDefaults *before* trying to launch the host app, and have the main app explicitly call `getInitialShare()` on `App.addListener('appStateChange', ...)` *and* on app boot.

---

## Tasks

### Task 1: Install plugin (skip if already done for Android)

**Files:**
- `package.json`
- `capacitor.config.ts`

**Step 1:** `@capgo/capacitor-share-target` is already a dep (Android-side). Confirm version is v8.x. If not, bump:

```
npm install @capgo/capacitor-share-target@^8
npx cap sync ios
```

**Step 2: Add iOS plugin config**

In `capacitor.config.ts`:

```typescript
plugins: {
  ...,
  CapacitorShareTarget: {
    appGroupId: 'group.com.forta.chat',
  },
},
```

**Step 3: Commit**

```
git add package.json package-lock.json capacitor.config.ts
git commit -m "feat(ios): configure CapacitorShareTarget app group"
```

---

### Task 2: Create Share Extension target in Xcode

**Files (created via Xcode):**
- `ios/App/ShareExtension/ShareViewController.swift`
- `ios/App/ShareExtension/Info.plist`
- `ios/App/ShareExtension/MainInterface.storyboard` (optional, can be programmatic)
- `ios/App/ShareExtension/ShareExtension.entitlements`

**Step 1: Add target**

In Xcode → File → New → Target → **Share Extension** → name `ShareExtension`, language Swift, bundle identifier `com.forta.chat.share`.

Xcode generates boilerplate. Confirm the new target is in `App.xcworkspace`.

**Step 2: Enable App Group**

Select `ShareExtension` target → Signing & Capabilities → + Capability → App Groups → check `group.com.forta.chat` (must already exist from `2026-05-12-ios-apns-push.md` Task 2).

**Step 3: Configure `Info.plist` activation rules**

Under `NSExtension` → `NSExtensionAttributes` → `NSExtensionActivationRule`, set the predicate to accept text, URLs, images, video, and files:

```xml
<key>NSExtensionActivationRule</key>
<dict>
  <key>NSExtensionActivationSupportsText</key>
  <true/>
  <key>NSExtensionActivationSupportsWebURL</key>
  <integer>1</integer>
  <key>NSExtensionActivationSupportsImageWithMaxCount</key>
  <integer>10</integer>
  <key>NSExtensionActivationSupportsMovieWithMaxCount</key>
  <integer>5</integer>
  <key>NSExtensionActivationSupportsFileWithMaxCount</key>
  <integer>10</integer>
</dict>
```

These limits match Android's behavior (multi-image up to 10, video up to 5).

**Step 4: ShareViewController.swift**

```swift
import UIKit
import Social
import MobileCoreServices
import UniformTypeIdentifiers

class ShareViewController: SLComposeServiceViewController {
    private let appGroup = "group.com.forta.chat"
    private let storeKey = "share-target-data"
    private let appUrlScheme = "forta://share"

    override func isContentValid() -> Bool { true }

    override func didSelectPost() {
        guard let extensionItem = extensionContext?.inputItems.first as? NSExtensionItem,
              let attachments = extensionItem.attachments else {
            self.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
            return
        }
        Task {
            var payload = SharedPayload(text: contentText, items: [])
            for provider in attachments {
                if let item = await readAttachment(provider) { payload.items.append(item) }
            }
            persist(payload)
            await MainActor.run {
                openHostApp()
                extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
            }
        }
    }

    override func configurationItems() -> [Any]! { [] }

    private func persist(_ payload: SharedPayload) {
        guard let defaults = UserDefaults(suiteName: appGroup) else { return }
        if let data = try? JSONEncoder().encode(payload) {
            defaults.set(data, forKey: storeKey)
            defaults.synchronize()
        }
    }

    private func openHostApp() {
        guard let url = URL(string: appUrlScheme) else { return }
        var responder: UIResponder? = self
        while responder != nil {
            if let app = responder as? UIApplication {
                app.perform(NSSelectorFromString("openURL:"), with: url)
                return
            }
            responder = responder?.next
        }
    }

    private func readAttachment(_ provider: NSItemProvider) async -> SharedItem? {
        // Resolve URL, image, or text. Copy file into App Group container so the
        // main app can still read it after the extension goes away.
        // ...implementation reads providers in priority order: file URL → image data → URL → plain text...
        return nil
    }
}

struct SharedPayload: Codable {
    var text: String?
    var items: [SharedItem]
}
struct SharedItem: Codable {
    var fileUrl: String?     // path inside App Group container
    var mimeType: String?
    var url: String?
    var text: String?
}
```

(The full `readAttachment` implementation handles `kUTTypeImage`, `kUTTypeMovie`, `kUTTypeFileURL`, `kUTTypeURL`, `kUTTypePlainText` — see Android `share-target.ts` for the canonical payload shape we need to produce.)

**Step 5: Add the URL scheme**

Main app's `Info.plist`:

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array>
      <string>forta</string>
    </array>
  </dict>
</array>
```

(Same scheme is also used as Android fallback — already declared there.)

**Step 6: Commit**

```
git add ios/App/ShareExtension/
git commit -m "feat(ios): Share Extension target writes shared payload to App Group"
```

---

### Task 3: Wire `share-target.ts` to read both Android and iOS payloads

**Files:**
- Modify: `src/shared/lib/share-target.ts`

**Step 1: Inspect existing Android-side reader**

The current `share-target.ts` (per `docs/plans/2026-04-09-android-share-target.md`) listens to `CapacitorShareTarget.addListener('shareTargetReceived', cb)` and pulls the initial payload via `getInitialShare()`. Both work on iOS too — the plugin abstracts the App Group read.

**Step 2: Verify payload shape**

The plugin emits a unified shape: `{ text?, url?, files?: Array<{path, mimeType}> }`. Both Android and iOS implementations of the plugin produce the same shape. **No JS changes needed** if the plugin is configured correctly with `appGroupId`.

**Step 3: Add an `App` URL handler for cold-launch via `forta://share`**

In `src/app/providers/initializers/deep-link-handler.ts`, when a URL with scheme `forta://share` arrives, call `CapacitorShareTarget.getInitialShare()` immediately (rather than waiting for the next listener tick). This closes the cold-launch race documented in the plugin.

**Step 4: Commit**

```
git add src/shared/lib/share-target.ts src/app/providers/initializers/deep-link-handler.ts
git commit -m "feat(ios): handle cold-launch share URL (forta://share)"
```

---

### Task 4: Manual test matrix

No code in this task — verification only.

**Steps:**

1. Send text from Notes → Share → Forta Chat → ForwardPicker opens with text preview.
2. Send 1 image from Photos → Share → Forta Chat → ForwardPicker opens with image preview.
3. Send 5 images from Photos → Share → Forta Chat → ForwardPicker opens with album.
4. Send video (>50MB) from Files → Share → Forta Chat → ForwardPicker uploads in background.
5. Cold-launch test: force-quit Forta Chat, share text from Notes → ForwardPicker opens after app launches.
6. Cancel inside ShareExtension's compose sheet → no notification, no payload written.
7. Forward from ShareExtension while logged out → ShareExtension still writes payload, main app shows it post-login (matches Android `processReferral` localStorage pattern).

---

## Verification gate (end of plan)

- [ ] `npm run build` — green.
- [ ] `npx vue-tsc --noEmit` — green.
- [ ] Manual test matrix above all green.
- [ ] App Store Connect: ShareExtension target signs and uploads via Archive without entitlement errors.

## Out of scope

- Direct-share contacts (showing recent chats inside the iOS Share Sheet) — requires `INSendMessageIntent` Intents extension, separate v2 spec.
- Action Extension (text editing inside other apps) — different surface, not requested.

