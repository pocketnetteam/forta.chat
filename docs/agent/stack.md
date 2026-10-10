# Technology stack

Detail reference for [AGENTS.md](../../AGENTS.md). Versions are ranges from `package.json`; the lockfile may resolve higher.

## Languages

- TypeScript (strict): application code (`src/**/*.ts`, `src/**/*.vue`)
- JavaScript (CommonJS): Electron main/preload (`electron/main.cjs`, `electron/preload.cjs`)
- Vue 3 SFCs: UI (`src/**/*.vue`)
- CSS: Tailwind + CSS custom properties

## Runtime

- Node.js 22+, npm 10+
- Browser / Electron (Chromium)
- Android + iOS via Capacitor 8 (`@capacitor/core` ^8.2, `@capacitor/ios` ^8.3.3)
- Lockfile: `package-lock.json` (`lockfileVersion: 3`)

## Frameworks

- Vue ^3.4.31 (Composition API), Vite ^5.3.4, Vue Router 4, Pinia ^2.2.0
- Dexie ^4.3.0, TailwindCSS ^3.4.7, Vitest ^4.0.18, vue-tsc ^2.0.26
- Electron ^40.6.0, electron-builder ^26.8.1
- TypeScript ^5.5.4, @vue/test-utils, happy-dom, fake-indexeddb
- unplugin-vue-components, unplugin-auto-import, class-variance-authority, Terser

## Key dependencies

- `matrix-js-sdk-bastyon` ^23.2.5: Matrix client (Bastyon fork)
- Capacitor plugins: camera, filesystem, share, push/local notifications, haptics, app, status-bar, keyboard, network, device
- `@capgo/capacitor-share-target`, `@capgo/capacitor-incoming-call-kit`, `@capacitor-community/sqlite`, `@capacitor-community/safe-area`
- Crypto: `@noble/secp256k1`, `miscreant`, `pbkdf2`, `bn.js`, `create-hash`; `underscore` in `matrix-crypto.ts` for every ordering step that feeds key derivation (same library as bastyon-chat `pcrypto.js`, so sort/uniq/iteration semantics match exactly)
- UI/media: `emoji-kitchen-mart`, `virtua`, `vue-virtual-scroller`, `heic2any`, `audio-recorder-polyfill`, `file-saver`
- Tor: `socks-proxy-agent`; forms: `vee-validate` + `@vee-validate/zod` + `zod`
- Local AI (optional/native): `local-ai` (git dependency `maxgithubprofile/local-ai`, pinned commit), `llama-cpp-pro` (git dependency, fork `j-bitmaker/llama-cpp-pro`, tag `v0.2.4-local-ai.2`)

## Configuration

- Env: `.env` via Vite `import.meta.env` (no separate `INTEGRATIONS.md`)
- `vite.config.ts`: build + Vitest (`test` block: happy-dom, `src/**/*.test.ts` / `scripts/**/*.test.ts`); there is no separate `vitest.config.ts`
- `tsconfig.json`: strict + path aliases (`@/`, `@app/`, `@entities/`, ...)
- `tailwind.config.js`: theme tokens
- `capacitor.config.ts`: `appId`, webDir, plugins; **minSdk/targetSdk** live in `android/variables.gradle` (24 / 36)

## Platform requirements

- Node.js 22+, npm 10+
- Android 7.0+ (API 24+), JDK 21 for Gradle builds
- iOS 15.0+ (macOS 14+, Xcode 16+)
- Windows 10+, macOS 10.13+, Linux (glibc 2.28+)
- Electron / Chromium via Electron 40.x
