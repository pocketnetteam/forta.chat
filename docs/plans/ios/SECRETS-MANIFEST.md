# iOS secrets — what is sensitive, where it lives, who can see it

> **Why this file:** by the end of Step 1 we will have collected several Apple/Firebase artefacts. Some are secrets, some merely look like secrets, some are just identifiers. This document is the project's source of truth on which is which, where each one is stored, and who has access. **Read it before adding anything to the iOS plumbing or sending anything to a vendor.**
>
> **Scope:** Step 1 artefacts only. Step 2+ adds provisioning profiles, certificates, App Store Connect API keys etc. — those will be appended here when they appear.

---

## Classification ladder

| Class | Definition | Storage |
|---|---|---|
| **SECRET** | Anyone with this can impersonate us against a third party (Apple, Firebase, etc.). Stolen → user harm. | 1Password vault "Forta" only. **Never** in repo, terminal scrollback, Slack messages, screenshots. |
| **CONFIDENTIAL** | Not directly weaponisable, but enumerable and identifying. We restrict because there's no upside to publishing. | 1Password (preferred) or repo, but with explicit policy below. |
| **PUBLIC** | Trivially derivable from the App Store listing or Firebase SDK config. Treating as a secret is ritual, not security. | Repo or 1Password — author's choice, prefer convenience. |

A useful smell test for the difference between CONFIDENTIAL and PUBLIC: if the value ends up in an end-user's app bundle (every iPhone that installs Forta Chat has it), it's PUBLIC. If it can only be obtained by Apple-Developer-portal access, it's CONFIDENTIAL or SECRET.

---

## Manifest

### A. APNs Auth Key — `.p8` file

- **Class:** **SECRET**.
- **Why:** anyone with this `.p8` + the Team ID + the Key ID can send arbitrary push notifications to every Forta Chat iOS user, until the key is revoked. This is the highest-value Apple credential we hold for the iOS port.
- **Where it lives:** 1Password vault "Forta" → item `Forta iOS APNs Key` → file attachment.
- **Who has access:** devops + iOS lead (currently 2 people). Add more only on need-to-know.
- **Where it must NEVER be:**
  - Repository (any branch, any worktree).
  - `~/Downloads/`, `~/Desktop/`, `tmp/` — Apple's download flow lands it in `~/Downloads/AuthKey_<KEYID>.p8`. **Move it to 1Password and `rm` the local copy** the same minute it is downloaded.
  - Slack, Discord, email attachments, screenshots — even via DM, even "just for a moment".
  - CI artefacts, build logs, environment files committed to the repo.
- **`.gitignore` enforcement:** `*.p8` is in `.gitignore`. Verify with `git check-ignore -v AuthKey_TEST.p8` (should print the rule).

### B. APNs Key ID — `<APNS_KEY_ID>`

- **Class:** **CONFIDENTIAL** (it's just a 10-char identifier, but combined with the `.p8` it forms credentials).
- **Where it lives:** 1Password vault "Forta" → item `Forta iOS APNs Key` → "Notes" field, label `Key ID`.
- **Why not in the repo:** trivial to look up in Apple Developer portal if you have access. Storing it in the repo makes the `.p8` slightly easier to misuse if it ever leaks. Cost of storing in 1Password is zero.

### C. Apple Team ID — `<TEAM_ID>`

- **Class:** **CONFIDENTIAL** trending toward **PUBLIC**.
- **Where it lives:** 1Password vault "Forta" → item `Forta Apple Developer — Team ID`. Also baked into:
  - The deployed AASA file (publicly visible at `https://forta.chat/.well-known/apple-app-site-association`).
  - The compiled `App.entitlements`/`embedded.mobileprovision` inside every shipped `.ipa` (publicly extractable from the App Store).
- **Why we still keep it out of the repo for Step 1:** because as long as the AASA hasn't been deployed yet, nothing is in the public domain, and pre-publishing the Team ID in a public repo could trip an internal "what is this random Apple identifier" review by an external maintainer. Once the AASA is live, treating it as PUBLIC is fine.

### D. Firebase iOS `GoogleService-Info.plist`

- **Class:** **PUBLIC** in practice.
- **Why public:** every iOS device with Forta Chat installed has this file inside the app bundle. It is trivially extractable from any `.ipa` with `unzip`. It contains the FCM Sender ID, GCM API key, Project ID, Client ID — none of which are secret in Firebase's documented threat model. Firebase server-side authentication uses a *separate* `service-account.json` with private key (which would be a SECRET, but we don't have one for the iOS app — Sygnal does the server-side push delivery).
- **Project policy:** **DO NOT commit it.** Yes, this contradicts the "PUBLIC" classification. Reasoning:
  1. The Android `google-services.json` is gitignored (`.gitignore:21`). Following the same pattern is the principle of least surprise.
  2. Onboarding cost of `download from Firebase console + drop into ios/App/App/` is ~2 minutes per new contributor. Not worth the deviation from the Android convention.
  3. If we ever rotate Firebase configurations (e.g. moving to a different Firebase project), an in-repo `.plist` becomes a quiet source of bugs ("why does CI use the old project?"). Forcing humans to re-download from Firebase makes the rotation explicit.
- **Where it lives during Step 1 (before `ios/` exists):**
  - **Primary:** 1Password vault "Forta" → item `Forta iOS Firebase Config` → file attachment.
  - **Local staging:** `tmp/GoogleService-Info.plist` (gitignored) — only as a convenience while you wait for Step 2. Remove from local disk afterwards.
- **Where it lives once `ios/` exists (Step 2):** `ios/App/App/GoogleService-Info.plist`. Added to the `App` Xcode target's "Copy Bundle Resources" build phase. **Not** added to the `NotificationService` or `ShareExtension` targets (they don't initialise FirebaseApp).
- **`.gitignore` enforcement:** `GoogleService-Info.plist` is in `.gitignore`. Verify with `git check-ignore -v ios/App/App/GoogleService-Info.plist` once that path exists.

### E. App Store Connect numeric ID — `<APP_STORE_ID>`

- **Class:** **PUBLIC**. The moment the app is searchable on the App Store, this number is in the URL bar at `apps.apple.com/app/idXXXXXX`.
- **Where it lives:** 1Password vault "Forta" → item `Forta App Store Connect` → field `Apple ID`. Also harmlessly committable to the repo when the Smart App Banner copy is added in `2026-05-12-ios-simple-tasks.md` Task 8.

### F. App Store Connect / Developer Portal credentials

- **Class:** **SECRET**.
- **Where they live:** the human's own iCloud Keychain / 1Password, with 2FA enforced on the Apple ID. We do not check in any Apple ID credentials anywhere.
- **For automation (CI, fastlane):** an App Store Connect API Key (`.p8` from <https://appstoreconnect.apple.com/access/integrations/api>) — **this is a different `.p8`** from the APNs one. When we add CI in a later Step, that `.p8` will be added to the manifest as a separate **SECRET** entry.

### G. Provisioning profiles + signing certificates

- **Class:** **CONFIDENTIAL** (development) / **SECRET** (distribution).
- **Where they live:** the developer's own machine's Keychain, plus periodic exports to 1Password for the lead's machine recovery scenario.
- **Repo policy:** never. `.gitignore` covers `*.mobileprovision`, `*.cer`, `*.certSigningRequest`, `*.p12` (verify in the gitignore changes accompanying this Step).
- **Note:** these don't exist yet in Step 1 — Xcode generates them when Step 2 first builds the app.

### H. Universal Links AASA file (`docs/plans/ios/aasa-template.json`)

- **Class:** **PUBLIC**. After deployment by the web team, the file is served unauthenticated at a well-known URL. It contains `<TEAM_ID>` (now treat as PUBLIC) and the bundle id (PUBLIC).
- **Where it lives:** the repo — `docs/plans/ios/aasa-template.json` (with `<TEAM_ID>` placeholder, not the real value). The deployed copy on `forta.chat` has the placeholder substituted by the web team.

### I. Sygnal pusher config

- **Class:** **PUBLIC** (the `app_id`s, the URL, the Firebase Sender ID).
- **However:** Sygnal-side credentials (the `.p8` if Sygnal hosts APNs directly, or the FCM server key for FCM-relay) are **SECRETs** held by the homeserver team in their infrastructure secrets store, not by us. We only need to share the APNs `.p8` (Section A) with them via 1Password (granted account access), not via attachment in messages.

---

## What goes in `tmp/` and why

`tmp/` is a developer-local staging area for in-flight artefacts that don't yet have a permanent home in the project. It is gitignored (covered by `*.local` and explicit `tmp/` rule in `.gitignore` — added in this Step's `.gitignore` update if not already covered).

**Allowed:**
- `tmp/GoogleService-Info.plist` while waiting for `ios/` to exist (Section D, "during Step 1").

**Forbidden:**
- `tmp/AuthKey_*.p8` — even briefly. Move to 1Password immediately upon download.
- Any `tmp/*.mobileprovision`, `tmp/*.p12`, `tmp/*.cer`.
- Any plaintext credential file.

---

## Pre-commit smell tests

Before any commit on the `ios/*` branches:

```bash
git diff --cached | grep -iE "BEGIN PRIVATE KEY|BEGIN RSA PRIVATE KEY|BEGIN EC PRIVATE KEY"
git diff --cached | grep -iE "fbase[A-Za-z0-9_-]{30,}"   # Firebase API keys (paranoid)
git diff --cached --name-only | grep -E "\.p8$|\.p12$|\.mobileprovision$|\.cer$"
```

All three must return nothing. If any of them match, **abort the commit** and audit what was staged.

A periodic full-history sweep (cheap, run on the iOS lead's machine monthly):

```bash
git log --all -p | grep -nE "BEGIN PRIVATE KEY|\.p8\b|\.p12\b" | head
```

Should return nothing for the iOS commits.

---

## "What if we leak something anyway"

| Leak | Immediate action |
|---|---|
| `.p8` APNs key in repo / Slack / screenshot | 1. Apple Developer Portal → Keys → revoke the leaked key. 2. Generate a new `.p8`. 3. Replace in 1Password. 4. Re-upload to Firebase Cloud Messaging config. 5. If the leak was public-internet (GitHub public, public Slack, screenshot in a tweet) — assume the key is compromised and rotate within 1 hour. |
| `GoogleService-Info.plist` in repo | Low severity (it's in every `.ipa` anyway), but to keep the convention clean: `git rm --cached`, add to `.gitignore` (already there), commit. No rotation needed. |
| Apple ID + password leaked | Change Apple ID password. Audit the App Store Connect / Developer access logs. Re-enable 2FA on a clean device. |
| App Store Connect API `.p8` leaked | Revoke + regenerate from <https://appstoreconnect.apple.com/access/integrations/api>. Update CI. |
| Provisioning profile leaked | Revoke + re-issue. Distribution profiles being leaked is a **serious** App Store Connect incident — Apple should be notified. |

---

## Access roster (snapshot)

> Update this list whenever someone joins or leaves the iOS team. Date the changes.

| Role | Name | 1Password vault "Forta" | Apple Developer | App Store Connect | Firebase | Sygnal |
|---|---|---|---|---|---|---|
| iOS lead | _to fill_ | full | Admin | Admin | Editor | n/a |
| Backend / Sygnal admin | _to fill_ | shared on `Forta iOS APNs Key` only | n/a | n/a | n/a | full |
| Web team contact | _to fill_ | n/a | n/a | n/a | n/a | n/a |

---

## Reminders (non-secret but easy to forget)

- The same Firebase project hosts the Android and iOS apps — **`PROJECT_ID`** must match between `android/app/google-services.json` and `ios/App/App/GoogleService-Info.plist`. If you ever see two different `PROJECT_ID`s, *something is wrong* — either Android pulled an old config or iOS was added to the wrong project.
- The APNs `.p8` is **Team-wide**, not bundle-specific. The same `.p8` could theoretically be used to push to other apps in the Forta Apple Developer Team. We don't ship any other apps yet, so this is moot, but factor it into reviews if/when we do.
- Apple **never re-issues** a downloaded `.p8`. If the file is lost, the only option is to revoke and create a new key — and re-upload to every consumer (Firebase, Sygnal). 1Password is the only durable copy.
