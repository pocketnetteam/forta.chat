# AGENTS.md — Forta Chat

> Canonical guide for AI agents working in this repo. Keep it current: when architecture or conventions change, update this file in the same session. `CLAUDE.md` only imports it. Detail lives in `docs/agent/*.md` and `docs/*.md`; keep this hub short.

## Project

**Forta Chat** is a decentralized E2E messenger on Matrix (fork `matrix-js-sdk-bastyon`) with local-first storage (Dexie), WebRTC calls, and login by Bastyon private key.

Platforms: Web, Electron (Windows / macOS / Linux), Android 7.0+ (minSdk 24), iOS 15+.

**Core value:** messages and media live on the device; sync and crypto work offline-first; UX is equally stable on Web, desktop, and mobile (including old Android WebView).

Constraints:
- Devices: Android API 24+ and iOS 15+; account for WebView / WKWebView differences.
- Approach: fixes and targeted improvements, no refactoring for its own sake.
- Data: Dexie is the single source of truth; do not duplicate server state in Pinia as a second source of truth.

## Stack

Vue 3 (Composition API) + Pinia + TypeScript (strict) + Vite + Vitest + Tailwind. Capacitor 8 for Android/iOS, Electron 40 for desktop. Matrix SDK `matrix-js-sdk-bastyon`; Dexie (IndexedDB) for local-first storage; WebRTC for calls. Node.js 22+, JDK 21 for Gradle, Xcode 16+ for iOS.

Versions, plugins, config files, platform requirements: [docs/agent/stack.md](docs/agent/stack.md).

## Architecture

Feature-Sliced Design (FSD):
- `src/app/`: boot, providers, routing
- `src/pages/`: route containers
- `src/widgets/`: compositions (ChatSidebar, ChatWindow, layouts)
- `src/features/`: features (messaging, contacts, video-calls, auth, ...)
- `src/entities/`: domain entities (chat, matrix, auth, user, call, ...)
- `src/shared/`: utilities, UI components, composables, local-db (Dexie)

Key decisions:
- **Dexie = single source of truth**: all data is read from IndexedDB through `useLiveQuery`.
- **SyncEngine** (`shared/lib/local-db/sync-engine.ts`): offline-first outbound queue (FIFO, exponential backoff + jitter).
- **EventWriter** (`shared/lib/local-db/event-writer.ts`): transactional writes of Matrix events into Dexie.
- **ChatVirtualScroller** (`shared/ui/ChatVirtualScroller.vue`): custom virtual scroll (column-reverse).
- **Calls**: `useCallService()` is a facade over `features/video-calls/model/call-*.ts`; every call resource has one owner keyed by `callId` (details in architecture.md, "Calls").

Layers, data flow, key abstractions, cross-cutting concerns: [docs/agent/architecture.md](docs/agent/architecture.md). Deeper dives: [docs/local-first-architecture.md](docs/local-first-architecture.md), [docs/architecture-data-flow.md](docs/architecture-data-flow.md), [docs/webrtc-architecture.md](docs/webrtc-architecture.md).

## Conventions

- `<script setup lang="ts">` everywhere; composables are `use-*.ts` modules; no `any` in application code; `@/` aliases instead of cross-module relative imports.
- Naming: components `PascalCase`, composables/files `kebab-case`, booleans `is/has/should/can`, handlers `handle*`/`on*`, constants `UPPER_SNAKE_CASE`.
- Tailwind utilities and CSS design tokens; no ad-hoc CSS.
- Errors: explicit `try-catch`, module-prefixed logs (`[App]`), user-facing text through i18n keys, no `console.log` in production code.
- Tests co-located with source (`*.test.ts`). Target 200-400 lines per file, split at 800.
- Tests run in Node by default; a file that needs a DOM starts with `// @vitest-environment happy-dom`. While iterating run single files (`npx vitest run <file>`); run the full suite in the background or with a 10-minute timeout, never two at once (details in conventions.md, "Tests").
- No ESLint/Prettier in the repo; `vue-tsc` is the type gate.

Full list with examples and the quality checklist: [docs/agent/conventions.md](docs/agent/conventions.md).

## Commits

Conventional Commits: `fix:`, `feat:`, `docs:`, `refactor:`, `test:`, `perf:`, `chore:`.

## Definition of done

Run the full verification after every task, before committing:

1. `npm run build` (runs `vue-tsc --noEmit` + vite; a separate `vue-tsc` run is not needed)
2. `npm run test`
3. Kotlin tests when `android/` changed: `cd android && ./gradlew :app:testSideloadDebugUnitTest --rerun-tasks` (without `--rerun-tasks` Gradle reports BUILD SUCCESSFUL from cache without running the tests)
4. Code review of the diff with the `code-review` skill (`/code-review`); pick the level by change size: `low`/`medium` for routine tasks, `high`/`max` for large changes, `ultra` for a PR before merge

Do not commit until all checks pass. There is no separate `lint` script.

**Tests:** every feature or bug fix ships with tests (unit + regression). A feature without tests is not done.

**Fixes that cannot be verified automatically:** if correctness is not proven by a test, types, or the build (needs a real device, a system screen, or an upgrade over an old install), add an entry to [docs/manual-verification.md](docs/manual-verification.md) **in the same commit**. Format and examples are in that file. Without the entry such a fix counts as unfinished.

## Project skills

| Skill | Description | Path |
|-------|-------------|------|
| device-ai-loop | On-device iteration on local-ai bugs via Capacitor/Android (Forta Chat as the consumer). | `.claude/skills/device-ai-loop/SKILL.md` |

## Docs index

- Builds: [docs/android-local-build.md](docs/android-local-build.md), [docs/ios-local-build.md](docs/ios-local-build.md), [docs/vite-cold-start-optimization.md](docs/vite-cold-start-optimization.md)
- Calls: [docs/webrtc-architecture.md](docs/webrtc-architecture.md), [docs/webrtc-calls-troubleshooting.md](docs/webrtc-calls-troubleshooting.md), [docs/webrtc-logs-analysis.md](docs/webrtc-logs-analysis.md), [docs/webrtc-solution-proposal.md](docs/webrtc-solution-proposal.md), [docs/call-bug-reproduction-matrix.md](docs/call-bug-reproduction-matrix.md), [docs/call-fix-checklist.md](docs/call-fix-checklist.md), [docs/call-bugs-needing-you.md](docs/call-bugs-needing-you.md)
- Product and audits: [docs/ux-specification.md](docs/ux-specification.md), [docs/bastyon-chat-vs-forta-audit.md](docs/bastyon-chat-vs-forta-audit.md), [docs/emoji.md](docs/emoji.md), [docs/how-to-get-private-key.md](docs/how-to-get-private-key.md)
- Verification: [docs/manual-verification.md](docs/manual-verification.md); plans in `docs/plans/`
