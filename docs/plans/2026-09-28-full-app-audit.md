# Full-app audit 2026-09 — fix plan

Bug audit of everything except calls, run 2026-09-25/26. Every finding was written by one reviewer and
independently checked by a second one that tried to refute it; P0s were reproduced on the bench where possible.
The owner-facing report (Russian, with cause, fix and linked forta-bugs reports per finding) is a private
artifact: https://claude.ai/artifact/BLUR5C39UtCMaUEvzdPNBn

Work happens on branch `audit/full-app-2026-09` in the worktree `.claude/worktrees/audit`, next to the calls
session on `fix/calls-2026-09`. `fix/calls-2026-09` is merged in (merge, not rebase) at the start of each batch.
Commits cite the finding id, e.g. `fix(boot): … (audit W2B-01)`.

Batches: 1 isolated P0s, 2 sending and session, 3 own/peer keys, 4 media/Tor/groups/contacts, 5 security and
desktop, 6 remaining P2/P3; `owner` = needs an owner decision before code. Platforms: A Android, i iOS, W web,
D desktop (Electron).

| ID | Priority | Batch | Platforms | Finding | Main file | Status |
|---|---|---|---|---|---|---|
| S2-01 | P0 | 2 | WAiD | Message send can queue "sending" forever with zero user-visible error when the Matrix client stays not-ready | `src/shared/lib/local-db/sync-engine.ts` | fixed |
| W2B-01 | P0 | 1 | A | Old Android WebView (< 71) shows a permanent white screen: matrix-js-sdk-bastyon uses `globalThis` at module load, before any app code or error handler runs | `index.html` | fixed |
| S1-01 | P0 | 1 | WAiD | Group common-key creation silently excludes members whose key info hasn't loaded yet — they can never read any message under that key generation | `src/entities/matrix/model/matrix-crypto.ts` | fixed |
| S1-02 | P0 | 1 | WAiD | "Peer hasn't published keys — you can send unencrypted" banner is false: the send path refuses to ever send plaintext to a private room, and the button becomes a silent no-op | `src/shared/lib/i18n/locales/en.ts` | fixed |
| S10-01 | P1 | owner | WAiD | Private key and Matrix access token stored in plaintext `localStorage` on every platform | `src/entities/auth/model/session-manager.ts` | open |
| S2-02 | P1 | 2 | WAiD | Photo/video/voice/file sends are dropped outright (not queued) when the Matrix client is briefly not ready — text sends were fixed for this, media sends were not | `src/features/messaging/model/use-messages.ts` | fixed |
| S3b-01 | P1 | 2 | AiWD | Active room silently vanishes when `getRoom()` transiently misses — matches #1390 | `src/entities/chat/model/chat-store.ts` | fixed |
| S5-01 | P1 | 3 | WAiD | Secondary accounts never get their encryption keys verified/republished — and the one manual recovery path the code refers to doesn't exist in the UI | `src/entities/auth/model/stores.ts` | open |
| S7-03 | P1 | 1 | AiWD | Adding a member without published encryption keys to a group breaks sending for the whole group, with no warning anywhere in the UI | `src/widgets/chat-window/ChatWindow.vue` | fixed |
| S8-01 | P1 | 4 | A | Homeserver mirror failover is fully disabled while Tor is on — a dead primary is never rotated away from | `src/entities/matrix/model/matrix-client.ts` | open |
| W2B-02 | P1 | 1 | Ai | `crypto.randomUUID()` unguarded and unpolyfilled on the attachment/voice send paths — silently swallowed by `Promise.allSettled` | `public/legacy-polyfills.js` | fixed |
| S10-02 | P1 | 5 | WAiD | SVG XSS sanitizer bypass on the registration captcha (`v-html` with untrusted content) | `src/features/auth/ui/register-form/steps/CaptchaStep.vue` | open |
| S3b-02 | P1 | 2 | AiWD | Invalid/expired Matrix session (M_UNKNOWN_TOKEN) is never detected — sync dies silently and the banner then LIES "up to date" | `src/entities/matrix/model/matrix-client.ts` | fixed |
| S4-01 | P1 | 4 | A | Native Tor media download has no connect/read timeout — hangs forever and permanently exhausts the app-wide 3-slot download gate | `android/app/src/main/java/com/forta/chat/plugins/filetransfer/TorFilePlugin.kt` | open |
| S7-01 | P1 | 4 | AiWD | Leaving/deleting a group silently no-ops on any network hiccup, and the tombstone auto-revives — the group reappears with zero explanation | `src/entities/chat/model/chat-store.ts` | open |
| S8-02 | P1 | owner | AD | Android and Electron auto-updaters never route through Tor — update checks/downloads silently fail wherever GitHub is blocked | `android/app/src/main/java/com/forta/chat/updater/AppUpdater.kt` | open |
| W2A-01 | P1 | 3 | WAiD | Self-missing encryption keys permanently block 1:1 messaging; UI blames the peer; the only fix path is dead code | `src/entities/matrix/model/matrix-crypto.ts` | open |
| S10-04 | P1 | 5 | D | Electron: unrestricted top-level navigation + `shell.openExternal` called with no scheme check — privileged preload bridge reachable from any origin | `electron/main.cjs` | open |
| S3-04 | P1 | 2 | AiWD | Dexie open/upgrade failure has no guaranteed user-visible recovery path | `src/shared/lib/local-db/index.ts` | open |
| S4-02 | P1 | 4 | Ai | Feed/channel native video player has no timeout on the initial load — spinner forever, no error, no fallback | `src/shared/lib/use-feed-video-player.ts` | open |
| S7-02 | P1 | 4 | AWD | Contact search reports "user not found" when the real cause is an RPC/network failure | `src/features/contacts/model/use-contacts.ts` | open |
| W2C-06 | P1 | 6 | Ai | Voice messages recorded with one MIME/codec are not guaranteed playable where the other platform's default codec differs (no cross-platform transcoding) | `src/features/messaging/model/use-voice-recorder.ts` | open |
| S10-05 | P1 | owner | WAiD | No Content-Security-Policy anywhere in the app | `index.html` | open |
| S6-02 | P1 | 5 | W | Web/Electron never request `Notification` permission — the OS banner can never appear | `src/shared/lib/notifications/web-notifier.ts` | open |
| W2C-05 | P1 | 4 | AiWD | A stuck large media upload blocks all further sends in that room, and every retry re-uploads the whole file | `src/shared/lib/local-db/sync-engine.ts` | open |
| S10-06 | P1 | owner | WAiD | Bug-report GitHub token bundled into the client with write scope; extensive PII shipped to a PUBLIC repo | `src/shared/lib/bug-report/bug-report-sender.ts` | open |
| W2B-05 | P1 | 1 | A | Found while fixing W2B-01: the Bastyon SDK in public/js is copied verbatim with `?.` / `??`, so WebView < 80 cannot parse sdk.js, actions.js, kit.js … and login/registration have no SDK | `vite.config.ts` | fixed |
| S1-03 | P2 | 3 | WAiD | "Peer hasn't published keys" verdict never self-heals automatically — only a manual Retry bypasses the stale profile cache | `src/widgets/chat-window/ChatWindow.vue` | open |
| S3-01 | P2 | 6 | AiWD | Buffered inbound writes (150ms/500ms) have no flush-on-background hook — message loss on app kill | `src/shared/lib/local-db/write-buffer.ts` | open |
| S4-03 | P2 | 4 | AiW | MediaViewer (full-screen / gallery) video lacks the timeout + codec-unsupported handling the inline chat bubble already has | `src/features/messaging/ui/MediaViewer.vue` | open |
| S6-01 | P2 | 6 | A | Push notification title/sender name bypasses local aliases and the raw-ID guard, can downgrade a good native title to a hex ID | `src/shared/lib/push/push-service.ts` | open |
| S8-03 | P2 | 5 | D | Packaged Electron app never shows a tray icon — "minimise to tray" hides the window with no way back except relaunching | `electron/tray.cjs` | open |
| W2A-04 | P2 | 3 | WAiD | Profile save failure reason is computed but discarded — every failure shows the same generic "failed to save profile" | `src/app/providers/initializers/app-initializer.ts` | open |
| S2-03 | P2 | 2 | WAiD | Once a queued op in a room permanently fails, later messages in the same room are sent out of order (FIFO invariant silently broken) | `src/shared/lib/local-db/sync-engine.ts` | open |
| S3-02 | P2 | 6 | AiWD | Live reaction to a not-yet-persisted message is silently and permanently dropped | `src/shared/lib/local-db/event-writer.ts` | open |
| S5-02 | P2 | 3 | A | `likelyBastyonUser` is a session-wide singleton that leaks from one account into another after `switchAccount` | `src/entities/auth/model/stores.ts` | open |
| S7-04 | P2 | 4 | AiWD | Kick / ban / promote-to-admin / mute failures are silently swallowed in the chat-info member menu | `src/features/chat-info/ui/ChatInfoPanel.vue` | open |
| S8-04 | P2 | 5 | D | Electron window has no application menu and no context menu — no right-click Copy/Paste, no discoverable Reload | `electron/main.cjs (весь файл — нет импорта Menu)` | open |
| W2C-04 | P2 | 6 | AWD | HEIC photos show no preview in the composer/attachment picker before sending | `src/features/messaging/model/use-media-upload.ts` | open |
| S1-04 | P2 | 3 | WAiD | Reply preview text is resolved once and permanently baked in — if resolved while the quoted message is still mid-decrypt, the reply shows "[encrypted]" forever even after the original decrypts fine | `src/entities/chat/model/chat-store.ts` | open |
| S3b-03 | P2 | 4 | AiWD | `acceptInvite` swallows `joinRoom` failures — user sees the invite screen again with no explanation | `src/entities/chat/model/chat-store.ts` | open |
| S4-04 | P2 | 6 | A | Save-to-gallery on Android 7–9 (API 24-28) never requests the runtime WRITE_EXTERNAL_STORAGE permission | `android/app/src/main/java/com/forta/chat/plugins/savemedia/SaveMediaPlugin.kt` | open |
| S6-03 | P2 | 6 | AiWD | Avatar → Matrix sync: unbounded `fetch` of the just-uploaded image, failure silently swallowed — Matrix avatar (`avatar_url`, drives group avatars) never gets set, no user-facing error | `src/entities/auth/lib/sync-profile-to-matrix.ts` | open |
| W2A-03 | P2 | 6 | WAiD | "Font Size" appearance setting has no effect on real chat messages — only the settings-page preview responds | `src/entities/theme/model/stores.ts` | open |
| S2-04 | P2 | 6 | WAiD | Legacy localStorage offline-queue path marks a message "sent" while it is only queued on-device, with no reconnect trigger beyond a browser `online` event | `src/features/messaging/model/use-messages.ts` | open |
| S3-03 | P2 | 6 | AiWD | Bulk timeline parse drops edits/reactions whose target isn't in the same parsed batch (no Dexie fallback, unlike replies) | `src/entities/chat/model/chat-store.ts` | open |
| S5-03 | P2 | 2 | WAiD | `bootStatus` reaches `"ready"` before Matrix ever starts connecting — the dedicated "matrix unreachable" boot-error screen can never render | `src/app/index.ts` | open |
| W2C-03 | P2 | 6 | Ai | Video-circle (video note) player force-loops and force-resumes playback, ignoring pause | `src/features/messaging/ui/VideoCirclePlayer.vue` | open |
| S1-05 | P2 | 6 | WAiD | Derived per-recipient AES key caches are keyed by identity+block, not by the actual public-key bytes — a peer's key rotation can leave a stale shared secret cached for the rest of a group's key-generation lifetime | `src/entities/matrix/model/matrix-crypto.ts` | open |
| S4-05 | P2 | 6 | Ai | Large media is fully materialized in memory at least twice (Blob + base64 string) on save and on native disk-cache write | `src/features/messaging/model/use-file-download.ts` | open |
| W2C-01 | P2 | 6 | A | Long-press context menu fires during native text selection, covering the message | `src/features/messaging/ui/MessageBubble.vue` | open |
| W2A-02 | P2 | 6 | WAD | `useLocalStorage` has no error handling — every appearance/theme setting can silently fail to persist | `src/shared/lib/browser/use-local-storage.ts` | open |
| S10-08 | P2 | 6 | WAiD | Logout's Dexie deletion failure is silently swallowed — "clear data" guarantee not enforced | `src/entities/auth/model/stores.ts` | open |
| W2D-03 | P2 | 6 | AiWD | Bug report submission is needlessly serial — screenshots upload one at a time, environment diagnostics fetch one native plugin at a time | `src/shared/lib/bug-report/bug-report-sender.ts` | open |
| W2C-02 | P2 | 6 | AiW | Unread-banner scroll-to-position races the (unawaited) window expansion — falls back to "scroll to bottom" | `src/features/messaging/ui/MessageList.vue` | open |
| W2D-01 | P2 | 6 | WDAi | Connection-status indicator freezes forever after the first ChatSidebar remount (orphaned singleton watcher) | `src/features/sync-status/model/use-sync-status.ts` | open |
| W2D-02 | P2 | 6 | WAiD | Channels/Bastyon-post browsing accumulates unbounded memory and DOM over a session | `src/entities/channel/model/channel-store.ts` | open |
| W2B-03 | P2 | 6 | A | `isFcmAvailable()` reflects build-time Firebase config, not runtime Google Play Services — push silently never works on Huawei/GMS-less devices (boot itself is NOT blocked — verified) | `android/app/src/main/java/com/forta/chat/plugins/push/PushDataPlugin.kt` | open |
| S5-04 | P3 | 5 | WAiD | Captcha SVG is sanitized with hand-rolled regexes before `v-html` (defense-in-depth gap, not currently exploitable from an attacker-controlled source) | `src/features/auth/ui/register-form/steps/CaptchaStep.vue` | open |
| S6-04 | P3 | 6 | Ai | Switching accounts leaks native PushData listeners — every future push and notification tap is handled once per prior account switch | `src/shared/lib/push/push-service.ts` | open |
| W2A-05 | P3 | 6 | WAiD | `editUserData` skips the unspents preload that registration has — profile save can silently hit `actions_noinputs` on a low-balance account | `src/app/providers/initializers/app-initializer.ts` | open |
| W2B-04 | P3 | 6 | A | Bug-report textarea has no draft persistence — rotation text-loss report could not be reproduced from `AndroidManifest`/component code | `android/app/src/main/AndroidManifest.xml` | open |
| S10-07 | P3 | 5 | D | Bug reports from Electron always show `OS: n/a` (P3, explicitly requested) | `src/shared/lib/bug-report/collect-environment.ts` | open |
