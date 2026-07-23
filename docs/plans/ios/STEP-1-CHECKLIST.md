# Step 1 — One-time external setup checklist

> **Audience:** the human running this Step.
>
> **Purpose:** track every external-tool action that must happen *before* any Swift/Vue code lands in `ios/`. Tick the checkboxes as you go. When everything is `[x]`, you are unblocked for Step 2 (`cap add ios`).
>
> **What this file is NOT:** a tutorial on how to use Apple Developer or Firebase. Each step links the canonical Apple/Firebase doc and only describes the project-specific input/output.

**Project-specific facts (do not paraphrase to vendors):**
- Bundle ID: `com.forta.chat`
- App Group: `group.com.forta.chat`
- AASA host: `https://forta.chat/.well-known/apple-app-site-association` (and `www.forta.chat`)
- Universal-Link path components: `/invite/*`, `/join/*`
- Pusher app_ids: `fortaios` (regular APNs), `fortaios.voip` (PushKit VoIP)
- Sygnal endpoint: `https://matrix.pocketnet.app/_matrix/push/v1/notify`

**Placeholders carried through this checklist (fill in once obtained, do not invent):**
- `<TEAM_ID>` — Apple Developer Team ID (10-char, e.g. `ABCD12EFGH`).
- `<APP_STORE_ID>` — App Store numeric id (e.g. `1234567890`); appears only after creating the App Store Connect listing.
- `<APNS_KEY_ID>` — 10-char ID of the `.p8` APNs auth key.

---

## Order of operations

The sections below are independent in *spirit* but have one hard ordering constraint:

```
A → B → (C, D in parallel) → E → (F, G in parallel) → H
```

- **A** must finish before anything else (Apple won't let you create an App ID without a Developer Program enrollment).
- **B** unlocks **C** (App Group needs an App ID).
- **D** is needed by **E** (Firebase wants the `.p8` + Key ID + Team ID to deliver via APNs).
- **F** and **G** can run in parallel as long as A is done — they go to *other people* (web team, homeserver team).
- **H** can be started right after **B** is done (all you need is a bundle id), but the `<APP_STORE_ID>` it produces is only required for Step 8 of `2026-05-12-ios-simple-tasks.md` (Smart App Banner). Don't block other sections on it.

---

## A. Apple Developer Program

**What you do (UI-driven):**

1. Go to <https://developer.apple.com/programs/enroll/>.
2. Sign in with the Apple ID that will own the Forta Chat publication (org account preferred — personal accounts cannot transfer apps later without paperwork).
3. Choose **Organization** if Forta has a legal entity (requires DUNS number, takes longer); choose **Individual** otherwise (faster, ~1 day).
4. Pay the annual $99 fee.
5. Wait for Apple's manual review email (1–3 business days for individuals, can be 1–2 weeks for organizations needing DUNS verification).

**Artifacts you receive:**
- An active Apple Developer Program membership.
- A 10-character **Team ID** (visible in Apple Developer → Account → Membership Details). Copy this into the placeholder below.

**Where to record:**
- Team ID: `<TEAM_ID>` → store in 1Password vault "Forta", item `Forta Apple Developer — Team ID` (just for reference; not a secret, but keep alongside other Apple identifiers).

**Verification:**
- [ ] You can sign in to <https://developer.apple.com/account/> and the page is not "Enroll Today" but a member dashboard.
- [ ] `<TEAM_ID>` recorded.

**Time:** ~10 min hands-on, then 1–3 days waiting for Apple. **Block here.** Nothing else proceeds until A is complete.

---

## B. App ID `com.forta.chat`

**What you do (UI-driven):**

1. Apple Developer Portal → **Certificates, Identifiers & Profiles** → **Identifiers** → **+** → **App IDs** → **App** → Continue.
2. Description: `Forta Chat iOS`.
3. Bundle ID: **Explicit** → `com.forta.chat`.
4. Capabilities — **enable**:
   - [ ] **Push Notifications** (required by Plan 3 APNs).
   - [ ] **App Groups** (required by Plans 3, 5, 6 — sharing data with NSE & Share Extension).
   - [ ] **Associated Domains** (required by Plan 7 Universal Links).
5. (Optional, for v2) **SiriKit** if/when we add direct-share to recents — leave unchecked for v1.
6. Capabilities — **leave disabled**:
   - HealthKit, HomeKit, In-App Purchase, Sign in with Apple, etc.
7. Continue → Register.

**Artifacts:**
- Registered App ID `com.forta.chat` with the three capabilities above ticked.

**Verification:**
- [ ] Identifier appears in the App IDs list with bundle id `com.forta.chat`.
- [ ] Editing the App ID shows Push Notifications, App Groups, Associated Domains all checked.

**Time:** ~5 min.

---

## C. App Group `group.com.forta.chat`

**Why now:** the App Group must exist before you can attach it to *any* App ID/Extension. The main App attaches it now; the future `NotificationService` and `ShareExtension` targets (Plans 3 and 6) will attach it later, after they are created in Xcode in Step 7 / Step 8.

**What you do (UI-driven):**

1. Apple Developer Portal → **Identifiers** → drop-down "App IDs" → switch to **App Groups** → **+** → Continue.
2. Description: `Forta Chat App Group`.
3. Identifier: `group.com.forta.chat` → Continue → Register.
4. Go back to **Identifiers** → App IDs → `com.forta.chat` → Edit → **App Groups** capability → **Configure** → check `group.com.forta.chat` → Save.
5. **Do not** create extension App IDs yet. The NSE and Share Extension are added as Xcode targets in Step 7 / Step 8 and Xcode auto-registers their App IDs at that point. When that happens, repeat sub-step 4 for those new App IDs (`com.forta.chat.NotificationService`, `com.forta.chat.ShareExtension`) — re-attach the same App Group.

**Artifacts:**
- App Group `group.com.forta.chat` exists.
- Main App ID is bound to it.

**Verification:**
- [ ] App Group identifier visible in Apple Developer Portal → Identifiers → App Groups.
- [ ] Main App ID `com.forta.chat` shows the App Group bound when edited.

**Reminder for later (do NOT do now, but write down):**
> **Attach `group.com.forta.chat` to `com.forta.chat.NotificationService` (Step 7) and `com.forta.chat.ShareExtension` (Step 8).**

**Time:** ~5 min.

---

## D. APNs Auth Key (`.p8`)

**Why a Key (not a Certificate):** APNs Auth Keys are reusable across all your apps in the same Team, never expire, and are required by Firebase for token-based APNs. Certificates are legacy.

**What you do (UI-driven):**

1. Apple Developer Portal → **Certificates, Identifiers & Profiles** → **Keys** → **+**.
2. Name: `Forta APNs Auth Key`.
3. Capabilities → check **Apple Push Notifications service (APNs)** → Continue → Register.
4. **Download** the `.p8` file. *You can only download it once.* If you miss this, you must revoke and create a new key.
5. On the same screen Apple shows the **Key ID** (10 chars). Copy it.

**Artifacts:**
- A `.p8` file on disk (e.g. `AuthKey_<APNS_KEY_ID>.p8`).
- The `<APNS_KEY_ID>` (10 chars).
- The `<TEAM_ID>` (already from Section A).

**Where to store (CRITICAL — do NOT commit any of these):**

| Artifact | Storage location |
|---|---|
| `.p8` file | 1Password vault "Forta" → new item `Forta iOS APNs Key` → attach the `.p8` file |
| `<APNS_KEY_ID>` | Same 1Password item, "Notes" field labelled `Key ID` |
| `<TEAM_ID>` | Same 1Password item, "Notes" field labelled `Team ID` (also in `Forta Apple Developer — Team ID` for cross-reference) |

After uploading to 1Password, **delete the local `.p8`** from `~/Downloads`. It is dangerous and irrecoverable.

**Verification:**
- [ ] 1Password item `Forta iOS APNs Key` exists with attachment + Key ID + Team ID in Notes.
- [ ] No copy of `*.p8` anywhere on the local filesystem outside 1Password.
- [ ] `git ls-files | grep p8` returns nothing (sanity check; `.gitignore` covers `*.p8`).

**Time:** ~5 min (plus ~2 min disciplined cleanup).

**Risk if mishandled:** Anyone with this `.p8` + Key ID + Team ID can send arbitrary push notifications to all your users until the key is revoked. Treat it like a private key.

---

## E. Firebase iOS app

**Prerequisites:** Sections A and D done. The existing Firebase project that already serves Android (the same project that produces `android/app/google-services.json`) will be reused — single project, two apps (Android + iOS).

**What you do (UI-driven):**

1. <https://console.firebase.google.com/> → open the **same** project that the Android app uses.
2. Project settings (gear icon) → **General** → scroll to "Your apps" → **Add app** → iOS icon.
3. iOS bundle ID: `com.forta.chat`.
4. App nickname: `Forta Chat iOS`.
5. App Store ID: leave blank for now (you don't have it yet — you fill this from Section H later when the App Store Connect listing exists; the field is optional and only used for App Store campaign attribution).
6. Click **Register app**.
7. **Download `GoogleService-Info.plist`** when prompted.
8. Skip the "Add Firebase SDK" and "Add initialization code" steps in the Firebase wizard — those happen in code in Plan 3 (`2026-05-12-ios-apns-push.md` Task 1). Just close the wizard.
9. Project settings → **Cloud Messaging** tab → "Apple app configuration" → upload the `.p8`:
   - APNs auth key: upload the `.p8` from Section D.
   - Key ID: paste `<APNS_KEY_ID>`.
   - Team ID: paste `<TEAM_ID>`.
   - Click Upload.

**Artifacts:**
- A new iOS app entry in Firebase console under the existing project.
- A `GoogleService-Info.plist` downloaded to your machine.

**Where to put `GoogleService-Info.plist`:**
- **Final destination:** `ios/App/App/GoogleService-Info.plist` — *but* the `ios/` directory does not exist yet (it is created by Step 2 `cap add ios`). Therefore:
- **For now (Step 1):** stage it in `tmp/GoogleService-Info.plist` (gitignored) **or** keep it in 1Password vault "Forta" → item `Forta iOS Firebase Config`. The latter is safer because it survives `git clean -fd`.
- **In Step 2:** copy from `tmp/` into `ios/App/App/`. Add to the `App` Xcode target (Target Membership checkbox in the file inspector — make sure only the main `App` target is checked, not the NSE or Share Extension targets, unless we explicitly need cross-target Firebase access; we do not for v1).

**`GoogleService-Info.plist` checkpoints (Plan 3 Task 1 will run this validation in code; pre-validate manually now to avoid wasted time later):**
- [ ] `BUNDLE_ID` = `com.forta.chat`.
- [ ] `IS_GCM_ENABLED` = `true`.
- [ ] `PROJECT_ID` matches the Android `google-services.json`'s `project_info.project_id` (single Firebase project, not two).

**Verification:**
- [ ] Firebase console → Project settings → "Your apps" lists *both* an Android app and an iOS app under the same project.
- [ ] Cloud Messaging tab shows the APNs key uploaded (Key ID visible, "Apple app configuration" section is no longer warning "Set up APNs").
- [ ] `GoogleService-Info.plist` opens as well-formed XML and the three checkpoints above pass.

**Time:** ~15 min.

---

## F. AASA file deployment

**Prerequisite:** Section A done (you need `<TEAM_ID>` to fill the AASA template).

**What you do (UI-driven):**

This step is *delegated to the web/hosting team* who controls `forta.chat` and `www.forta.chat` HTTPS roots. You hand them three things:

1. The AASA template file: `docs/plans/ios/aasa-template.json` (in this repo). Substitute `<TEAM_ID>` with the actual value from Section A *before* sending.
2. The deployment instructions: `docs/plans/ios/aasa-DEPLOYMENT.md` (in this repo).
3. A short cover note (Slack / email) — already drafted in `aasa-DEPLOYMENT.md` "Cover note" section. Copy-paste, fill in the team handle, send.

**Artifacts the web team must produce:**
- `https://forta.chat/.well-known/apple-app-site-association` — 200 OK, `Content-Type: application/json`, no redirects, valid HTTPS cert, JSON body matching the filled template.
- `https://www.forta.chat/.well-known/apple-app-site-association` — same.

**Verification (run from any machine):**

```bash
curl -I https://forta.chat/.well-known/apple-app-site-association
curl -I https://www.forta.chat/.well-known/apple-app-site-association
```

Expected response headers (both URLs):
- `HTTP/2 200` (no 30x).
- `Content-Type: application/json` (NOT `text/html`).

```bash
curl https://forta.chat/.well-known/apple-app-site-association | python -m json.tool
```

Expected: pretty-printed JSON identical to the filled template.

When you have a Mac available (Step 2 onwards), the canonical Apple test:

```bash
sudo swcutil dl -d forta.chat
sudo swcutil dl -d www.forta.chat
```

Expected: `swcutil` reports the AASA was downloaded and parsed without errors; `appIDs` shows `<TEAM_ID>.com.forta.chat`.

**Verification checklist:**
- [ ] Both `forta.chat` and `www.forta.chat` AASA URLs return 200 + `application/json`.
- [ ] JSON body matches `aasa-template.json` with `<TEAM_ID>` substituted.
- [ ] On macOS, `swcutil dl -d forta.chat` succeeds (defer until you have a Mac).

**Time:**
- Hands-on for you: ~10 min (filling the template, drafting the email).
- Web team turnaround: variable, typically same-day to 2 days.

**Common failures (call these out in the cover note):**
- The AASA file is sometimes served as `text/html` (default for static files of unrecognized extension). The web server config must add `application/json` for `apple-app-site-association` (no `.json` extension by Apple's spec).
- A 301 redirect (e.g. `forta.chat → www.forta.chat`) breaks AASA. Both hosts must serve their own copy directly.
- Cloudflare's Minify / Auto-format setting can rewrite the file — turn it off for this path.

---

## G. Sygnal pusher configuration request

**Prerequisite:** Sections A and B done conceptually (we know the bundle id and the Team is set up). Section D's `.p8` is *not* shared with Sygnal — Sygnal sends to APNs via Apple-issued tokens; the `.p8` lives in Firebase only.

**What you do (UI-driven):**

This step is *delegated to the homeserver / Sygnal admin team* (the people who run `matrix.pocketnet.app`). The two pushers cannot exist until Sygnal's `sygnal.yaml` declares the `app_id`s.

1. Open `docs/plans/ios/SYGNAL-CONFIG-REQUEST.md` in this repo.
2. Copy the "Email/Slack body" verbatim, substitute the `<your-name>` placeholder, send to the homeserver-admin contact.
3. Wait for confirmation that:
   - `app_id: fortaios` is registered as kind `http` to `https://matrix.pocketnet.app/_matrix/push/v1/notify`, with `format: event_id_only`, and forwards APNs payloads with `mutable-content: 1`.
   - `app_id: fortaios.voip` is registered as kind `http` to the same URL, with VoIP-class APNs delivery (PushKit), only triggered for `m.call.invite` events.

**Artifacts:**
- A confirmation message from the Sygnal admin that both `app_id`s are live in `sygnal.yaml`.

**Verification (after Plan 3 Task 1 + Plan 5 Task 3 register pushers from the iOS app):**
- [ ] Calling Matrix `getPushers()` from the JS console on a logged-in iOS device returns two entries: `app_id: 'fortaios'` and `app_id: 'fortaios.voip'`. (This verification only happens *after* Step 4 / Step 6 of `README.md`. Defer until then.)
- [ ] Sygnal admin replies "deployed" / "live".

**Time:**
- Hands-on for you: ~5 min.
- Sygnal-team turnaround: typically same-day for known requesters.

---

## H. App Store Connect listing (minimal)

**Prerequisite:** Section A done. Sections B–G can still be in flight.

**Why now:** the `<APP_STORE_ID>` (the `1234567890` part of `apps.apple.com/app/idXXXXX`) is needed by Plan 1 Task 8 (Smart App Banner copy in Safari). It is also needed for the Firebase "App Store ID" field (optional but lets Firebase Dynamic Links / campaign measurement work). The `<APP_STORE_ID>` is *only* assigned after you create the listing — even if you never submit it. So we create the listing now with the bare minimum; everything else (screenshots, full description, App Privacy questionnaire, etc.) is deferred to Step 10.

**What you do (UI-driven):**

1. <https://appstoreconnect.apple.com/> → **My Apps** → **+** → **New App**.
2. Platforms: **iOS** (only — we don't ship a Mac Catalyst version).
3. Name: `Forta Chat`.
4. Primary language: `English (U.S.)`. (Russian goes in as an additional localization later in Step 10.)
5. Bundle ID: pick `com.forta.chat - Forta Chat iOS` from the drop-down (this list is populated by your Section B App ID; if it's empty, Section B did not complete).
6. SKU: `forta-chat-ios` (free-form, never user-visible, your internal id).
7. User access: leave default (Full Access).
8. Click Create.

That creates the listing. You will land on the App Information page.

9. App Information page → fill the *minimum required* fields:
   - Subtitle: `End-to-end encrypted messenger`. (Or whatever marketing decides — can be edited later.)
   - Privacy Policy URL: `https://forta.chat/privacy.html` (the existing privacy page used on Android — confirm it is accessible at that exact path; if hosted elsewhere, use the canonical URL).
   - Category: Primary `Social Networking`. Secondary leave blank.
   - Content Rights: "Does not contain, show, or access third-party content."
   - Age Rating: Click Edit, answer the questionnaire honestly. For a messenger expect `12+` (user-generated content).
10. **Stop.** Do **not**:
    - Upload screenshots.
    - Fill the long App Description.
    - Submit the App Privacy questionnaire (Microphone / Camera / etc.). Step 10 of `README.md` covers that.
    - Click "Submit for Review".

**Artifacts:**
- A "Prepare for Submission" status app in App Store Connect.
- An **`<APP_STORE_ID>`** — visible in the URL bar (`appstoreconnect.apple.com/apps/<APP_STORE_ID>/...`) and in App Information → "Apple ID" field.

**Where to record:**
- `<APP_STORE_ID>` → 1Password vault "Forta" → item `Forta App Store Connect` → field `Apple ID`. Cross-reference: also paste it back into the Firebase iOS app config's "App Store ID" field (Section E sub-step 5 was deferred — do it now).

**Verification:**
- [ ] App Store Connect → My Apps shows "Forta Chat" with status "Prepare for Submission".
- [ ] `<APP_STORE_ID>` recorded in 1Password.
- [ ] Firebase iOS app's "App Store ID" field is now populated.

**Time:** ~30 min (most of it is the Age Rating questionnaire and waffling on the subtitle).

**Out of scope here (Step 10 territory — do NOT do now, even if tempted):**
- App Privacy questionnaire (Microphone, Camera, Contacts answers).
- Full app description, keywords, support URL beyond privacy.
- Marketing URL, promotional text.
- Screenshots, app preview videos.
- Pricing & Availability (default Free, Worldwide, fine for now).
- TestFlight beta testers.

---

## Final pre-Step-2 verification

Once all of A–H are ticked, run this final sanity pass:

- [ ] `<TEAM_ID>` is recorded in 1Password and used in the deployed AASA.
- [ ] App ID `com.forta.chat` exists with Push Notifications, App Groups, Associated Domains capabilities checked.
- [ ] App Group `group.com.forta.chat` exists and is bound to the main App ID.
- [ ] `.p8` APNs auth key is in 1Password only — local filesystem cleaned.
- [ ] `<APNS_KEY_ID>` is recorded next to the `.p8` in 1Password.
- [ ] Firebase project has both Android and iOS apps under the same `PROJECT_ID`. APNs key uploaded.
- [ ] `GoogleService-Info.plist` is staged (1Password or `tmp/`) ready to drop into `ios/App/App/` when Step 2 creates that folder.
- [ ] `BUNDLE_ID`/`IS_GCM_ENABLED`/`PROJECT_ID` checks in the plist all pass.
- [ ] AASA file is live at both `forta.chat` and `www.forta.chat`, returns 200 + `application/json`, content matches the filled template.
- [ ] Sygnal has `app_id: fortaios` and `app_id: fortaios.voip` configured.
- [ ] App Store Connect listing exists, `<APP_STORE_ID>` recorded.
- [ ] **`.gitignore` covers `*.p8`, `GoogleService-Info.plist`, `*.mobileprovision`, `*.cer`, `*.certSigningRequest`** — re-verify with `git check-ignore -v ios/App/App/GoogleService-Info.plist` once `ios/` exists; for now confirm the policy by reading `.gitignore`.

When all boxes are checked: **you are unblocked for Step 2** (`cap add ios` + bootstrap, see `README.md` Step 2 / `2026-05-12-ios-simple-tasks.md` Tasks 1–3 + 9).

If Section F (AASA) is still in web-team queue, you can proceed to Step 2 / Step 3 anyway — Universal Links are not exercised until Plan 7 (Step 8). But B, C, D, E, G must all be done before Step 4 (Push) is meaningful.
