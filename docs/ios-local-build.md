# Local iOS Build

> Mirrors `docs/android-local-build.md` for the Capacitor iOS target.
> Full multi-phase iOS port plan lives under `docs/plans/ios/README.md`.

## Prerequisites

iOS builds only run on macOS — Capacitor delegates to `xcodebuild` and CocoaPods, both of which are macOS-only.

1. **macOS 14+** (Sonoma) on a machine with at least 30 GB free for Xcode + simulators.

2. **Xcode 16+** from the Mac App Store. Open it once after installing to accept the license:
   ```bash
   sudo xcode-select --install
   sudo xcodebuild -license accept
   ```

3. **CocoaPods 1.15+**:
   ```bash
   sudo gem install cocoapods
   pod --version
   ```

4. **Node.js 18+** + **npm 7+**.

5. **Apple Developer Program** account ($99/year) — required to install on a physical device or distribute via TestFlight. The simulator does not require an account, but features that depend on real hardware (Push, CallKit, Camera microphone) do.

## Debug build (simulator)

```bash
# 1. Build the web bundle and sync to the iOS project
npm run cap:build:ios

# 2. Open the workspace in Xcode
npm run cap:open:ios

# 3. In Xcode: pick an iOS 17 simulator (e.g. iPhone 15) → Run (⌘R)
```

Alternatively, `npm run cap:run:ios` launches the default simulator from the CLI.

## Debug build (physical device)

1. Connect an iPhone/iPad via USB.
2. Open `ios/App/App.xcworkspace` in Xcode.
3. Select the App target → **Signing & Capabilities** → check **Automatically manage signing** → choose your Team.
4. On the device, enable **Settings → Privacy & Security → Developer Mode**.
5. Pick the device from the run-destination dropdown → Run.

## Release build (TestFlight / App Store)

The release pipeline is **not** automated yet — submission goes through Xcode Organizer:

1. Set the run-destination to **Any iOS Device (arm64)**.
2. **Product → Archive**.
3. Organizer opens automatically → select the archive → **Distribute App** → **App Store Connect** → **Upload**.
4. Once Apple finishes processing (~10 min), invite testers via TestFlight or submit for review from App Store Connect.

## Capacitor sync gotchas

- After installing or upgrading a Capacitor plugin always run `npm run cap:build:ios` (`cap sync ios` does both web copy and pod install).
- If `pod install` fails with `xcrun: error: invalid active developer path`, re-run `sudo xcode-select --install`.
- Custom Swift plugins must live inside `ios/App/App/` and be registered in `capacitor.config.ts` if they introduce a JS bridge.

## Reference

| Setting | Value |
|---|---|
| Bundle id | `com.forta.chat` |
| Deployment target | iOS 15.0 |
| Capacitor | 8.2 |
| App Groups | `group.com.forta.chat` (used by Share Extension + NSE later) |
| URL scheme | `forta-app://` (Universal Links use `https://forta.chat/{invite,join}`) |

## Known iOS differences

See the same-named section in `README.md` for the user-facing list (Tor not shipped, no auto-update, system locale, WKWebView WebRTC).

## Where to look next

- `docs/plans/ios/README.md` — port roadmap and phase index.
- `docs/plans/ios/2026-05-12-ios-overall-plan.md` — full plugin matrix, risk register, definition of done.
- Sub-plan files in `docs/plans/ios/` — one per area (push, calls, share, universal links, etc.).
