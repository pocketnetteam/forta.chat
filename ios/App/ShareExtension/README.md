# ShareExtension target

> **iOS Share Extension** for Forta Chat. Surfaces the app in the system
> Share Sheet and hands shared text / URLs / images / videos / files to the
> main app via the `group.com.forta.chat` App Group, then re-launches the
> host app via `forta://share` so the existing `share-target.ts` JS
> pipeline opens the ForwardPicker.

## Files

- `ShareViewController.swift` — extension entry point. Subclasses
  `SLComposeServiceViewController` (the system-supplied "compose" sheet
  with a caption field). On submit it copies file payloads into
  `<app group container>/share-inbox/`, writes a dictionary at
  `share-target-data` in the App Group's `UserDefaults` matching the
  `@capgo/capacitor-share-target` plugin schema, then opens the host app
  via `forta://share`.
- `Info.plist` — declares the `NSExtension` point
  (`com.apple.share-services`), the principal class
  (`$(PRODUCT_MODULE_NAME).ShareViewController`), and the
  `NSExtensionActivationRule` that tells iOS which content types make
  Forta Chat appear in the Share Sheet (text, web URL, ≤10 images,
  ≤5 movies, ≤10 files).
- `ShareExtension.entitlements` — `com.apple.security.application-groups`
  with `group.com.forta.chat`. Must match the main app and NSE so all
  three processes share the same `UserDefaults` and container.

## Bundle / scheme contract

- Bundle id: `com.forta.chat.ShareExtension`. Must end in
  `.ShareExtension` (or another sub-id of `com.forta.chat`) so the
  embedded `.appex` is signed by the same provisioning profile family
  as the main app.
- App Group: `group.com.forta.chat` (shared with main app + NSE).
- UserDefaults key: `share-target-data`. The Capgo plugin's iOS
  implementation reads this key on `load()`, on every `capacitorOpenURL`
  with `host == "share"` or `path == "/share"`, and on every
  `UIApplication.didBecomeActiveNotification` — so the cold-launch race
  is closed natively. We do **not** also write `SharedData` (the second
  key the plugin checks) — picking one keeps the on-disk format
  unambiguous.
- Payload schema (must match what the plugin expects):

  ```jsonc
  {
    "title":  "",                      // unused; reserved for future direct-share
    "texts":  ["plain text", "https://example.com/link"],
    "files": [
      { "uri": "/private/.../share-inbox/IMG_001.jpg",
        "name": "IMG_001.jpg",
        "mimeType": "image/jpeg" }
    ]
  }
  ```

- URL scheme: `forta://share`. Registered in `App/Info.plist` under
  `CFBundleURLTypes`. Picking up by the host app:

  ```
  ShareViewController.openHostApp()
    → openURL: forta://share
    → AppDelegate.application(_:open:options:)
    → ApplicationDelegateProxy.shared.application(_:open:options:)
    → posts notification .capacitorOpenURL
    → CapacitorShareTargetPlugin.handleOpenURL — flushes share-target-data
    → JS shareReceived event → src/shared/lib/share-target.ts
  ```

  The custom scheme is also routed through Capacitor's `App.appUrlOpen`
  Capacitor-JS event, which `src/app/providers/initializers/deep-link-handler.ts`
  consumes; `forta://share` is silently dropped there because it carries
  no invite/join target — the side-effect (waking the host app) is what
  matters.

## One-time Xcode UI setup

The source files in this folder are committed to git, but the **Xcode
target must be created manually on a Mac** with Xcode 16+. Until that's
done, the files compile only by being added to another target — they
will not produce a `.appex` bundle.

Follow these steps in Xcode:

1. Open `ios/App/App.xcworkspace`.
2. **File → New → Target…**
3. Choose **iOS → Share Extension**.
4. Settings:
   - Product Name: `ShareExtension`
   - Team: same Apple Developer team as the main `App` target.
   - Organization Identifier: `com.forta` (so the bundle id becomes
     `com.forta.chat.ShareExtension`).
   - Bundle Identifier: `com.forta.chat.ShareExtension`.
   - Language: Swift.
   - Project: `App` (only option).
   - Embed in Application: `App`.
5. Click **Finish**. If Xcode asks to "Activate ShareExtension scheme",
   say **Cancel** — we build it as a dependency of the `App` scheme.
6. Xcode generates a default `ShareViewController.swift`, `Info.plist`,
   and `MainInterface.storyboard` inside `ios/App/ShareExtension/` and
   adds them to the target.
   - **Delete the generated `ShareViewController.swift` and
     `Info.plist` from disk** and re-add the committed files in this
     folder via right-click → "Add Files to App…", with the only
     checkbox set to the `ShareExtension` target.
   - **Delete the generated `MainInterface.storyboard`** — our
     `Info.plist` declares `NSExtensionPrincipalClass` instead of a
     storyboard, so the `.storyboard` is not needed and would clash if
     present in the bundle.
7. Select the `ShareExtension` target → **Signing & Capabilities**:
   - **+ Capability → App Groups**, then check `group.com.forta.chat`
     (already provisioned for the main `App` target).
   - Confirm `Code Signing Entitlements` points at
     `ShareExtension/ShareExtension.entitlements`.
8. Set the extension's deployment target to **iOS 15.0** (matches the
   main app and `SLComposeServiceViewController` requirements).
9. Build the `App` scheme. The Share Extension compiles as part of the
   main app build and is embedded into the `.app` bundle. Verify with:

   ```
   cd ios/App
   xcodebuild -workspace App.xcworkspace -scheme App -configuration Debug \
     -sdk iphonesimulator build
   ls -d build/Debug-iphonesimulator/App.app/PlugIns/ShareExtension.appex
   ```

   The last command should list the embedded extension.

## Verifying delivery on a real device or simulator

The Share Extension itself runs fine in the simulator; the host app's
`forta://share` callback also works in the simulator (no real APNs or
PushKit needed for share testing).

1. Build and run `App` on the simulator.
2. Open the **Photos** app → pick an image → **Share** → tap **Forta
   Chat** in the share sheet. (If "Forta Chat" is missing, scroll all the
   way right in the app row and tap **More** to enable it.)
3. The standard compose sheet opens. Tap **Post**. Forta Chat opens and
   the ForwardPicker shows the image as a forwarding payload.

If the share sheet entry is missing, verify:

- The `.appex` bundle is embedded inside the built `.app`
  (`PlugIns/ShareExtension.appex`).
- The `NSExtensionActivationRule` keys in `Info.plist` cover the kind
  of payload you're sharing (e.g. `SupportsImageWithMaxCount` for
  Photos, `SupportsFileWithMaxCount` for Files.app).

If the share sheet entry is present but tapping **Post** does not open
Forta Chat, the most common causes are:

- App Group entitlement missing on either the main app or the extension
  → both targets must have `group.com.forta.chat` checked under Signing
  & Capabilities.
- `forta` URL scheme missing from `App/Info.plist` `CFBundleURLTypes`.
- Plugin `appGroupId` in `capacitor.config.ts` not matching the
  extension's `appGroupId` constant in `ShareViewController.swift`.

## What this target does NOT do

- Does **not** ship a custom UI — relies on the system-supplied
  `SLComposeServiceViewController` compose sheet. We may swap to a
  custom `UIViewController` later if a recent-chats picker becomes
  in-scope (out of scope for this iteration; see the parent plan).
- Does **not** support direct-share recent contacts (the in-Share-Sheet
  list of suggested chats). Apple gates that on `INSendMessageIntent`
  and an Intents extension target — separate v2 spec.
- Does **not** decrypt or upload anything. The extension's only job is
  to copy bytes into the App Group container; the host app's existing
  `share-target.ts` → ForwardPicker → upload pipeline does the rest.
