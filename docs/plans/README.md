# Feature plans & design docs

Dated design/implementation plans. They are **historical**: useful for context and decisions, not current runbooks.

For living docs use:

- [AGENTS.md](../../AGENTS.md) — stack, architecture rules, verification
- [docs/agent/architecture.md](../agent/architecture.md), [docs/architecture-data-flow.md](../architecture-data-flow.md)
- [docs/android-local-build.md](../android-local-build.md) / [docs/ios-local-build.md](../ios-local-build.md)
- [docs/manual-verification.md](../manual-verification.md) — what still waits for a check on a device

Commands inside plans (e.g. `npm run lint`, old paths like `new-bastyon-chat`, `SettingsPage.vue`, `com/bastyon/chat`, `Podfile` / `App.xcworkspace`) may be stale — follow `AGENTS.md` for current verification. Unticked checkboxes in a plan do not mean the work is open: most plans were never ticked. The table below is the status.

## Status index (checked against the code, 2026-10-05)

**Open work**

| Plan | State | What is open |
|---|---|---|
| [2026-10-02-decrypt-priority-roadmap](2026-10-02-decrypt-priority-roadmap.md) | stages 0–3, 5 done | 4 (decrypt only visible bubbles on open), 6 (partly), 7 (`fullRoomRefresh` 35 s) |
| [2026-10-03-initial-sync-lazy-members](2026-10-03-initial-sync-lazy-members.md) | phase I done (`5ff01d6d`), phase II cancelled | slow first `/sync`: stage 1A (proxy timeout, server side), response composition, variant D |
| [2026-08-29-registration-actions-sdk-migration](2026-08-29-registration-actions-sdk-migration.md) | not started | everything (tracks A and B) |
| [2026-06-30-android-chat-open-send-fix](2026-06-30-android-chat-open-send-fix.md) | phase 1 superseded by 2026-09-28; partly | write path: tasks 2.2–2.4 |
| [2026-06-30-maestro-android-e2e](2026-06-30-maestro-android-e2e.md) | done differently (`e2e/README.md`) | `03-room-switch` flow |
| [2026-09-18-calls-handoff](2026-09-18-calls-handoff.md) | branch merged (PR #253) | items without ✅ in «Открытые задачи»: CI build for real bug reports, TURN 443, release + report recount, OEM devices, Tor binary |
| [TURN-443-REQUEST](TURN-443-REQUEST.md) | request to homeserver admins | TURN over TLS on 443 |
| [ios/](ios/README.md) | all sub-plans landed | Sygnal pushers, NSE decrypt, AASA check — see its status table |
| [electron/](electron/README.md) | shipping | user install doc, `electron.d.ts`, IPC tests, signing checks (`ci-desktop.md`) |
| [llama2/](llama2/README.md) | phases 1–7, perf tuning, multi-model done | device QA (`qa-checklist-phase7.md`), phase R (RAG) |
| [tor/forta-chat-tor-integration-plan](tor/forta-chat-tor-integration-plan.md) | phases done | unit tests for `AltTransportActive` and `TorRouteDecider.kt`; first-run defaults (product decision) |

**Done**

| Plan | Notes |
|---|---|
| [2026-09-28-chat-open-local-first](2026-09-28-chat-open-local-first.md) | stages 0–4; device measurements pending in `manual-verification.md` |
| 2026-02-19 media-voice, 2026-03-03 chat-info-panel, 2026-03-06 invite-friend, 2026-03-06 post-player, 2026-03-09 chat-search (redesign, v2), 2026-03-10 channels-tab, 2026-03-10 link-preview, 2026-03-11 paste-drop-files, 2026-03-13 video-circles, 2026-03-18 unread-ux, 2026-03-19 optimistic-media-upload, 2026-03-20 native-webrtc-android, 2026-03-20 voice-message-ux, 2026-03-23 reply-preview-persistence, 2026-03-25 encrypted-display, 2026-03-30 logout-data-cleanup, 2026-03-30 room-list-scalability, 2026-03-31 android-back-button, 2026-03-31 reliable-registration, 2026-04-09 android-share-target, 2026-04-09 encryption-guard, 2026-04-09 telegram-forward, 2026-04-17 bug-report-status-tracker | spot-checked: the files and symbols the plans create exist |
| [2026-03-13-youth-chat-pack](2026-03-13-youth-chat-pack.md) | Emoji Kitchen, GIF, reaction effects, typing bubble shipped; sticker packs removed later (`8b0d0675`) |
| [2026-03-19-capacitor-mobile-app](2026-03-19-capacitor-mobile-app.md) | shipped; Android package is `com.forta.chat`, not `com.bastyon.chat` as in the plan |
| [2026-03-20-sync-status-ux](2026-03-20-sync-status-ux.md) | shipped as `features/sync-status/model/use-sync-status.ts` (the plan's `use-chat-sync-status.ts` was not created) |
| [2026-03-20-tor-status-mobile-design](2026-03-20-tor-status-mobile-design.md), [2026-03-27-tor-graceful-degradation](2026-03-27-tor-graceful-degradation-plan.md) | marked done in the plans |
| [2026-03-31-android-safe-area-insets](2026-03-31-android-safe-area-insets.md) | superseded: keyboard and insets now go through `--app-bottom-inset` (see `docs/agent/architecture.md`, «Mobile layout») |

**Not checked** (no status in the plan, not reconciled with the code): 2026-03-18 read-watermarks, 2026-03-19 chat-list-consistency-fix, 2026-03-19 message-overlap-fix, 2026-03-23 perf-cascade-elimination, 2026-03-23 telegram-like-scroll, 2026-03-24 perf-first-launch, 2026-03-25 fix-android-recording, 2026-03-25 perf-large-accounts, `dexiemigration/`, `AVATAR-UPLOAD-PEERTUBE.md`.
