# Feature plans & design docs

Dated design/implementation plans. They are **historical**: useful for context and decisions, not current runbooks.

For living docs use:

- [AGENTS.md](../../AGENTS.md) — stack, architecture rules, verification
- [docs/agent/architecture.md](../agent/architecture.md), [docs/architecture-data-flow.md](../architecture-data-flow.md)
- [docs/android-local-build.md](../android-local-build.md) / [docs/ios-local-build.md](../ios-local-build.md)
- [docs/manual-verification.md](../manual-verification.md) — what still waits for a check on a device

Commands inside plans (e.g. `npm run lint`, old paths like `com/bastyon/chat`, `Podfile` / `App.xcworkspace`) may be stale — follow `AGENTS.md` for current verification. Unticked checkboxes in a plan do not mean the work is open: most plans were never ticked. The table below is the status.

## Status index (checked against the code, 2026-10-05)

**Open work**

| Plan | State | What is open |
|---|---|---|
| [2026-10-08-background-voice-playback](2026-10-08-background-voice-playback.md) | not started | everything (stages 0–8) |
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

**Not checked** (no status, not reconciled with the code): `dexiemigration/`, `AVATAR-UPLOAD-PEERTUBE.md`.

## Deleted plans

Removed 2026-10-05: the plans dated 2026-02 … 2026-04 and `llama/` (the first local-AI plan, replaced by
`llama2/`). Of the dated plans, 28 were spot-checked as shipped or superseded (sticker packs from the youth-chat
pack were removed later, `8b0d0675`); 8 were never reconciled with the code: read-watermarks,
chat-list-consistency-fix, message-overlap-fix, perf-cascade-elimination, telegram-like-scroll, perf-first-launch,
fix-android-recording, perf-large-accounts. Restore any of them from
the last commit that had it:

```bash
git show 5ce16751:docs/plans/<file>.md          # read
git ls-tree -r --name-only 5ce16751 docs/plans   # full list
```
