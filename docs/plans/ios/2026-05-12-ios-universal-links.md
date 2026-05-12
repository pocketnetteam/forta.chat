# iOS Universal Links Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Parent plan:** `2026-05-12-ios-overall-plan.md`

**Goal:** Make `https://forta.chat/invite/...` and `https://forta.chat/join/...` open the iOS app directly (no Safari roundtrip), reusing the existing `parse-invite-url.ts` parser. Match the Android App Links behavior.

---

## Critical reassessment

### Plugin landscape

- **`@capacitor/app`** (already installed) gives us `appUrlOpen` event — fires when the app is launched from a Universal Link **and** when an already-running app receives one.
- No additional plugin needed. `parse-invite-url.ts` and the existing `deep-link-handler.ts` Android pipeline are platform-agnostic.

### What we need

1. Apple App Site Association (AASA) JSON file at `https://forta.chat/.well-known/apple-app-site-association` with our App ID + paths.
2. Associated Domains capability in Xcode.
3. `applinks:forta.chat` and `applinks:www.forta.chat` entitlements.
4. Verify the JS handler already covers iOS — it does, since `App.addListener('appUrlOpen', ...)` is the same on both platforms.

---

## Tasks

### Task 1: Apple App Site Association file

**Files:**
- Coordinate with web-team / hosting: place at `https://forta.chat/.well-known/apple-app-site-association`. Must be served as `application/json` (NOT `text/html`), no redirects, HTTPS, valid cert.

**Step 1: Generate AASA**

```json
{
  "applinks": {
    "details": [
      {
        "appIDs": ["TEAMID.com.forta.chat"],
        "components": [
          { "/": "/invite/*", "comment": "Invite links — open in app" },
          { "/": "/join/*",   "comment": "Direct join links — open in app" }
        ]
      }
    ]
  }
}
```

Replace `TEAMID` with the actual Apple Developer Team ID (visible in Apple Developer portal, format e.g. `ABCD12EFGH`).

**Step 2: Upload to web server**

Place at both `https://forta.chat/.well-known/apple-app-site-association` and `https://www.forta.chat/.well-known/apple-app-site-association`.

**Step 3: Verify**

```
curl -I https://forta.chat/.well-known/apple-app-site-association
```

Expected: `200 OK`, `Content-Type: application/json`, no redirect.

Use Apple's [AASA validator](https://branch.io/resources/aasa-validator/) or `swcutil` on macOS:

```
sudo swcutil dl -d forta.chat
```

Expected: AASA parsed, no errors.

**Step 4: No git commit here** — file lives on the web server, not in this repo. Document the deployment in `docs/android-local-build.md` (rename to `docs/mobile-local-build.md` or add a parallel `docs/ios-local-build.md`).

---

### Task 2: Associated Domains capability + entitlements

**Files:**
- Modify: `ios/App/App/App.entitlements` (created when capability is enabled in Xcode)

**Step 1: Enable in Xcode**

Project → App target → Signing & Capabilities → + Capability → Associated Domains → add:
- `applinks:forta.chat`
- `applinks:www.forta.chat`

(Optionally also `webcredentials:forta.chat` if/when we want password autofill — not v1.)

This adds to `App.entitlements`:

```xml
<key>com.apple.developer.associated-domains</key>
<array>
  <string>applinks:forta.chat</string>
  <string>applinks:www.forta.chat</string>
</array>
```

**Step 2: Re-sign provisioning profile**

In Apple Developer portal, the App ID `com.forta.chat` must have the "Associated Domains" capability checked, and the provisioning profile regenerated. Xcode will refuse to build if the entitlement is not in the profile.

**Step 3: Commit entitlements**

```
git add ios/App/App/App.entitlements
git commit -m "feat(ios): Associated Domains entitlement for Universal Links"
```

---

### Task 3: Verify `appUrlOpen` is wired and routes to existing parser

**Files:**
- Audit: `src/app/providers/initializers/deep-link-handler.ts`

**Step 1: Verify the existing listener**

The Android implementation listens on `App.addListener('appUrlOpen', ({ url }) => ...)` and feeds `url` into `parseInviteUrl(url)`. Same listener fires on iOS for Universal Links — no code change.

**Step 2: Add a one-line guard for cold-start**

If on iOS the deep link arrived before our listener was registered (rare with Capacitor 8, but possible during early boot), call `App.getLaunchUrl()`:

```typescript
import { App } from '@capacitor/app';
import { isIOS } from '@/shared/lib/platform';
...
if (isIOS) {
  const launch = await App.getLaunchUrl();
  if (launch?.url) handleUrl(launch.url);
}
App.addListener('appUrlOpen', ({ url }) => handleUrl(url));
```

This is also valid (no-op) on Android, but isolating it to iOS keeps semantics explicit.

**Step 3: Verify with tests**

`src/app/providers/initializers/deep-link-handler.test.ts` should add an iOS branch covering `App.getLaunchUrl` returning a URL.

**Step 4: Commit**

```
git add src/app/providers/initializers/deep-link-handler.ts src/app/providers/initializers/deep-link-handler.test.ts
git commit -m "feat(ios): handle cold-start launch URL via App.getLaunchUrl"
```

---

### Task 4: Manual test matrix

No code in this task.

**Steps (real device, after deploying AASA + installing TestFlight build):**

1. From Safari, open `https://forta.chat/invite/abc123`. App should open directly to invite screen — **no Safari prompt**, no banner. (If Safari shows the page, AASA wasn't fetched in time. iOS caches AASA per install — uninstall + reinstall to retest.)
2. From Mail, tap an `https://forta.chat/join/xyz` link. Same as above.
3. App is running in foreground when link tapped from Notes → app reacts to link without restarting.
4. App killed when link tapped → app cold-starts and routes to invite/join.

If step 1 fails: check Xcode device console for `swc:` errors (Apple's Universal Links daemon).

---

### Task 5: Documentation

**Files:**
- Create: `docs/ios-local-build.md`

**Step 1: Mirror `docs/android-local-build.md` for iOS**

Cover: prerequisites (macOS 14+, Xcode 16+, CocoaPods, Apple Developer account), `npm run cap:build:ios`, `cd ios/App && pod install`, run on simulator/device, signing, archive for App Store, Universal Links AASA hosting.

**Step 2: Commit**

```
git add docs/ios-local-build.md
git commit -m "docs: iOS local build instructions"
```

---

## Verification gate (end of plan)

- [ ] `curl https://forta.chat/.well-known/apple-app-site-association` returns 200 OK with valid JSON.
- [ ] Apple's `swcutil dl -d forta.chat` reports the AASA as parsed.
- [ ] Entitlement file committed.
- [ ] Tests green.
- [ ] Manual test matrix all green on real device.

## Out of scope

- Universal Links for paths other than `/invite` and `/join`. Adding more paths means updating both AASA and `parse-invite-url.ts` — a separate ticket.
- Smart App Banners (the Safari-shown "Open in App" banner) — gated by `<meta name="apple-itunes-app">` in the website, not the app.
- Web Credentials / Sign in with Apple — out of scope.

