<div align="center">

**English · [Русский](README.ru.md)**

<a href="https://forta.chat">
  <img src="public/forta-icon.png" alt="Forta Chat" width="120" height="120" />
</a>

# Forta Chat

**Decentralized messenger on the Matrix protocol with Bastyon integration**

[![Latest Release](https://img.shields.io/github/v/release/pocketnetteam/forta.chat?style=flat-square&color=%232ea44f)](https://github.com/pocketnetteam/forta.chat/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/pocketnetteam/forta.chat/total?style=flat-square)](https://github.com/pocketnetteam/forta.chat/releases)
[![Stars](https://img.shields.io/github/stars/pocketnetteam/forta.chat?style=flat-square)](https://github.com/pocketnetteam/forta.chat/stargazers)
[![Issues](https://img.shields.io/github/issues/pocketnetteam/forta.chat?style=flat-square)](https://github.com/pocketnetteam/forta.chat/issues)
[![Vue 3](https://img.shields.io/badge/Vue-3.4-4FC08D?style=flat-square&logo=vue.js&logoColor=white)](https://vuejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Capacitor](https://img.shields.io/badge/Capacitor-8.2-119EFF?style=flat-square&logo=capacitor&logoColor=white)](https://capacitorjs.com/)
[![Electron](https://img.shields.io/badge/Electron-40-47848F?style=flat-square&logo=electron&logoColor=white)](https://www.electronjs.org/)

### [🌐 forta.chat](https://forta.chat) · [📥 Download](https://github.com/pocketnetteam/forta.chat/releases/latest) · [📖 Docs](#documentation) · [🐛 Issues](https://github.com/pocketnetteam/forta.chat/issues) · [🔐 Bastyon](https://bastyon.com)

<br />

<a href="https://forta.chat">
  <img src="public/og-image.jpg" alt="Forta Chat preview" width="720" />
</a>

</div>

---

## About

**Forta Chat** is an end-to-end encrypted messenger built on a **local-first** architecture: every message, media file, and piece of metadata lives in IndexedDB on your device, while background workers sync with a Matrix server. You sign in with the private key of your [Bastyon](https://bastyon.com) account — no usernames, no passwords.

Available on the web at [forta.chat](https://forta.chat), on desktop (Windows / macOS / Linux), and on Android.

## Features

- 🔒 **End-to-end encryption** for direct and group chats (Matrix Olm/Megolm via `matrix-js-sdk-bastyon`)
- 📴 **Local-first storage**: Dexie (IndexedDB) as the single source of truth, offline-first outbound queue via `SyncEngine` (FIFO + exponential backoff)
- 📞 **Video calls** — 1:1 and group WebRTC — see [docs/webrtc-architecture.md](docs/webrtc-architecture.md)
- 🎙 **Rich media**: photos, videos, voice notes, video circles, and files with crash-recovery uploads
- 🌐 **Public rooms & invite links**, reactions, polls, read watermarks, edit/redact
- 🔑 **Sign in with Bastyon** — use your existing Bastyon private key — see [docs/how-to-get-private-key.md](docs/how-to-get-private-key.md)
- 🖥 **Cross-platform**: Web, Electron (Windows / macOS / Linux), Android 7.0+ (API 24+)

## Download

| Platform | Link |
|----------|------|
| 🌐 **Web** | [forta.chat](https://forta.chat) |
| 🤖 **Android (APK)** | [releases/latest](https://github.com/pocketnetteam/forta.chat/releases/latest) |
| 🪟 **Windows** | build locally — see [Electron](#electron-desktop) |
| 🍎 **macOS** | build locally — see [Electron](#electron-desktop) |
| 🐧 **Linux** | build locally — see [Electron](#electron-desktop) |

## Tech stack

| Layer | Technology |
|-------|-----------|
| UI | Vue 3 (Composition API, `<script setup>`) + TailwindCSS |
| State | Pinia |
| Routing | Vue Router 4 |
| Bundler | Vite 5 |
| Types | TypeScript 5.5 (strict) + `vue-tsc` |
| Tests | Vitest + `@vue/test-utils` + happy-dom + fake-indexeddb |
| Storage | Dexie 4 (IndexedDB) |
| Chat protocol | `matrix-js-sdk-bastyon` (Matrix fork maintained by Bastyon) |
| Calls | WebRTC |
| Desktop | Electron 40 + electron-builder |
| Mobile | Capacitor 8 (Android) |
| Crypto | `@noble/secp256k1`, `miscreant` (AEAD), `pbkdf2` |

## Quick start

### Prerequisites

- Node.js 18+
- npm 7+

### Install

```bash
git clone https://github.com/pocketnetteam/forta.chat.git
cd forta.chat
npm install
```

### Dev mode (web)

```bash
npm run dev
```

Opens `http://localhost:5173`. You'll need a Bastyon private key to sign in — see [docs/how-to-get-private-key.md](docs/how-to-get-private-key.md).

### Production build

```bash
npm run build       # vue-tsc + vite build + public JS minification
npm run preview     # preview the built bundle
```

### Tests

```bash
npm run test        # one-shot
npm run test:watch  # watch mode
```

## Building per platform

### Electron (desktop)

```bash
npm run electron:dev              # dev (vite + electron together)
npm run electron:preview          # preview built bundle in Electron
npm run electron:build            # build for the current OS
npm run electron:build:win        # Windows
npm run electron:build:mac        # macOS
npm run electron:build:linux      # Linux
```

Build config — [electron-builder.json](electron-builder.json), main process — [electron/main.cjs](electron/main.cjs).

### Android (Capacitor)

```bash
npm run cap:build   # vite build + cap sync android
npm run cap:open    # open the project in Android Studio
npm run cap:run     # run on a connected device
```

Full APK build guide (debug/release, keystore, env vars) — [docs/android-local-build.md](docs/android-local-build.md).

Capacitor config: [capacitor.config.ts](capacitor.config.ts) (`appId: com.forta.chat`, `minSdk 24`, `targetSdk 36`).

## Architecture

The project follows **Feature-Sliced Design**:

```
src/
├── app/         # entry, providers, routing, boot
├── pages/       # route containers
├── widgets/     # composed surfaces (ChatSidebar, ChatWindow, layouts)
├── features/    # messaging, auth, contacts, video-calls, search, ...
├── entities/    # auth, chat, matrix, user, call, channel, media, ...
└── shared/      # ui, lib, composables, local-db (Dexie), config
```

Key abstractions:

- **`shared/lib/local-db/ChatDatabase`** — Dexie schema, repositories (`MessageRepository`, `RoomRepository`, `UserRepository`)
- **`shared/lib/local-db/sync-engine.ts`** — offline-first FIFO outbound queue
- **`shared/lib/local-db/event-writer.ts`** — transactional Matrix-event writes into Dexie
- **`shared/lib/local-db/decryption-worker.ts`** — background decryption with retry
- **`shared/ui/ChatVirtualScroller.vue`** — custom virtual scroll (column-reverse)

Deep dives:

- [docs/local-first-architecture.md](docs/local-first-architecture.md) — Dexie, SyncEngine, EventWriter, decryption
- [docs/architecture-data-flow.md](docs/architecture-data-flow.md) — data flow, reactivity, lifecycle
- [docs/webrtc-architecture.md](docs/webrtc-architecture.md) — calls, signaling, AudioRouter
- [docs/ux-specification.md](docs/ux-specification.md) — UX spec for screens and flows

## Documentation

| File | Topic |
|------|-------|
| [CLAUDE.md](CLAUDE.md) | Development rules (stack, architecture, conventions, verification) |
| [docs/local-first-architecture.md](docs/local-first-architecture.md) | Local-first: Dexie, SyncEngine, EventWriter |
| [docs/architecture-data-flow.md](docs/architecture-data-flow.md) | Data flow and reactivity |
| [docs/ux-specification.md](docs/ux-specification.md) | UX specification |
| [docs/webrtc-architecture.md](docs/webrtc-architecture.md) | Call architecture |
| [docs/webrtc-calls-troubleshooting.md](docs/webrtc-calls-troubleshooting.md) | Call troubleshooting |
| [docs/webrtc-logs-analysis.md](docs/webrtc-logs-analysis.md) | WebRTC log analysis |
| [docs/webrtc-solution-proposal.md](docs/webrtc-solution-proposal.md) | WebRTC improvement proposals |
| [docs/android-local-build.md](docs/android-local-build.md) | Local Android APK build |
| [docs/how-to-get-private-key.md](docs/how-to-get-private-key.md) | How to obtain a Bastyon private key |
| [docs/plans/](docs/plans/) | Design docs and feature plans |

## Development

Before each commit, run the full verification pipeline:

```bash
npm run build              # build (vue-tsc + vite)
npx vue-tsc --noEmit       # type-check
npm run test               # tests
```

Conventions, git-worktree isolation, TDD, code review and the rest — in [CLAUDE.md](CLAUDE.md).

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`fix:`, `feat:`, `refactor:`, `docs:`, `test:`, `perf:`, `chore:`).

## Legal

- [Privacy Policy](https://forta.chat/privacy.html)
- [Terms of Use](https://forta.chat/terms.html)

## Links

- 🌐 Website: [forta.chat](https://forta.chat)
- 📦 Repository: [github.com/pocketnetteam/forta.chat](https://github.com/pocketnetteam/forta.chat)
- 📥 Releases: [github.com/pocketnetteam/forta.chat/releases](https://github.com/pocketnetteam/forta.chat/releases)
- 🐛 Issues: [github.com/pocketnetteam/forta.chat/issues](https://github.com/pocketnetteam/forta.chat/issues)
- 🔐 Bastyon: [bastyon.com](https://bastyon.com)

<div align="center">
<sub>Made with ❤️ for decentralized communication</sub>
</div>
