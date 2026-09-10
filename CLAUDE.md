# Project Rules

## Стек

Vue 3 (Composition API) + Pinia + TypeScript + Vite + Vitest + Capacitor (mobile). Matrix SDK (matrix-js-sdk-bastyon) для коммуникации. Dexie (IndexedDB) для local-first хранения. WebRTC для видеозвонков.

## Архитектура

Feature-Sliced Design (FSD):
- `src/app/` — boot, провайдеры, роутинг
- `src/pages/` — route-контейнеры
- `src/widgets/` — композиции (ChatSidebar, ChatWindow, layouts)
- `src/features/` — фичи (messaging, contacts, video-calls, auth, …)
- `src/entities/` — бизнес-сущности (chat, matrix, auth, user, call, …)
- `src/shared/` — утилиты, UI-компоненты, composables, local-db (Dexie)

Ключевые решения:
- **Dexie = single source of truth** — все данные читаются из IndexedDB через `useLiveQuery`
- **SyncEngine** (`shared/lib/local-db/sync-engine.ts`) — offline-first очередь отправки (FIFO, exponential backoff + jitter)
- **EventWriter** (`shared/lib/local-db/event-writer.ts`) — транзакционная запись событий Matrix → Dexie
- **ChatVirtualScroller** (`shared/ui/ChatVirtualScroller.vue`) — кастомный виртуальный скролл (column-reverse)

## Коммит конвенции

Conventional Commits: `fix:`, `feat:`, `docs:`, `refactor:`, `test:`, `perf:`, `chore:`

## Верификация перед коммитом (ОБЯЗАТЕЛЬНО)

После завершения каждой задачи обязательно прогонять полную верификацию перед коммитом:

1. `npm run build` — сборка (`vue-tsc --noEmit` + vite; отдельный `vue-tsc` не нужен)
2. `npm run test` — тесты
3. Code review — skill `code-review` (`/code-review`) — архитектурный ревью изменений

Отдельного `npm run lint` / ESLint в репозитории нет — не требовать линтинг, пока скрипт не появится.

Не коммитить, пока все проверки не пройдены.

## Тесты (ОБЯЗАТЕЛЬНО)

Каждая фича/багфикс ОБЯЗАТЕЛЬНО сопровождается тестами (unit + регрессионные). Фича без тестов не считается завершённой.

## Финальная верификация (ОБЯЗАТЕЛЬНО)

Перед коммитом/PR активировать для финальной проверки:

- Code review — skill `code-review` (`/code-review`), уровень по масштабу изменений:
  - `low`/`medium` — для обычных задач
  - `high`/`max` — для крупных изменений
  - `ultra` — для PR перед мержем

<!-- GSD:project-start source:PROJECT.md -->
## Project

**Forta Chat** — децентрализованный E2E-мессенджер на Matrix (fork `matrix-js-sdk-bastyon`) с local-first хранением (Dexie), WebRTC-звонками и входом по приватному ключу Bastyon.

Платформы: Web, Electron (Windows / macOS / Linux), Android 7.0+ (minSdk 24), iOS 15+.

**Core Value:** Сообщения и медиа живут на устройстве; синхронизация и криптография работают offline-first; UX одинаково стабилен на Web, desktop и mobile (включая старые Android WebView).

### Constraints

- **Устройства**: Android API 24+ и iOS 15+ — учитывать различия WebView / WKWebView
- **Подход**: Фикс и целевые улучшения — без рефакторинга ради рефакторинга
- **Данные**: Dexie = single source of truth; не дублировать серверное состояние в Pinia как SoT
<!-- GSD:project-end -->

<!-- GSD:stack-start source:codebase/STACK.md -->
## Technology Stack

## Languages
- TypeScript (strict) — application code (`src/**/*.ts`, `src/**/*.vue`)
- JavaScript (CommonJS) — Electron main/preload (`electron/main.cjs`, `electron/preload.cjs`)
- Vue 3 SFCs — UI (`src/**/*.vue`)
- CSS — Tailwind + CSS custom properties
## Runtime
- Node.js 18+, npm 7+
- Browser / Electron (Chromium)
- Android + iOS via Capacitor 8 (`@capacitor/core` ^8.2, `@capacitor/ios` ^8.3.3)
- Lockfile: `package-lock.json` (`lockfileVersion: 3`)
## Frameworks (ranges from `package.json`; lock may resolve higher)
- Vue ^3.4.31 (Composition API), Vite ^5.3.4, Vue Router 4, Pinia ^2.2.0
- Dexie ^4.3.0, TailwindCSS ^3.4.7, Vitest ^4.0.18, vue-tsc ^2.0.26
- Electron ^40.6.0, electron-builder ^26.8.1
- TypeScript ^5.5.4, @vue/test-utils, happy-dom, fake-indexeddb
- unplugin-vue-components, unplugin-auto-import, class-variance-authority, Terser
## Key Dependencies
- `matrix-js-sdk-bastyon` ^23.2.5 — Matrix client (Bastyon fork)
- Capacitor plugins: camera, filesystem, share, push/local notifications, haptics, app, status-bar, keyboard, network, device
- `@capgo/capacitor-share-target`, `@capgo/capacitor-incoming-call-kit`, `@capacitor-community/sqlite`, `@capacitor-community/safe-area`
- Crypto: `@noble/secp256k1`, `miscreant`, `pbkdf2`, `bn.js`, `create-hash`
- UI/media: `emoji-kitchen-mart`, `virtua`, `vue-virtual-scroller`, `heic2any`, `audio-recorder-polyfill`, `file-saver`
- Tor: `socks-proxy-agent`; forms: `vee-validate` + `@vee-validate/zod` + `zod`
- Local AI (optional/native): `local-ai` (file dep), `llama-cpp-pro`
## Configuration
- Env: `.env` via Vite `import.meta.env` (no separate `INTEGRATIONS.md`)
- `vite.config.ts` — build + Vitest (`test` block: happy-dom, `src/**/*.test.ts` / `scripts/**/*.test.ts`); отдельного `vitest.config.ts` нет
- `tsconfig.json` — strict + path aliases (`@/`, `@app/`, `@entities/`, …)
- `tailwind.config.js` — theme tokens
- `capacitor.config.ts` — `appId`, webDir, plugins; **minSdk/targetSdk** — в `android/variables.gradle` (24 / 36)
## Platform Requirements
- Node.js 18+, npm 7+
- Android 7.0+ (API 24+), JDK 21 for Gradle builds
- iOS 15.0+ (macOS 14+, Xcode 16+)
- Windows 10+, macOS 10.13+, Linux (glibc 2.28+)
- Electron / Chromium via Electron 40.x
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

## Naming Patterns
- Vue components: `PascalCase` (e.g., `Button.vue`, `MediaGrid.vue`, `ChatVirtualScroller.vue`)
- Composables/hooks: `kebab-case` with `use-` prefix (e.g., `use-async-operation.ts`, `use-toast.ts`, `use-file-download.ts`)
- Utilities/functions: `camelCase` (e.g., `promise-pool.ts`, `message-format.ts`)
- Tests: `kebab-case.test.ts` co-located with source (e.g., `use-messages.test.ts` next to `use-messages.ts`)
- Directories: `kebab-case` organized by feature or domain (e.g., `shared/lib/`, `features/messaging/`, `entities/chat/`)
- `camelCase`: All exported functions and methods use camelCase
- Booleans: Prefixed with `is`, `has`, `should`, or `can` (e.g., `isLoading`, `hasError`, `shouldSendOnEnter`, `canJoinRoom`)
- Async functions: Use `async`/`await` pattern (e.g., `refresh()`, `sendMessage()`, `toggleReaction()`)
- Event handlers: Prefixed with `handle` or `on` (e.g., `handleRetryUsername`, `handleUploadCancelled`, `onMounted`)
- `UPPER_SNAKE_CASE` for globally accessible constants
- Inline constants use descriptive names (e.g., `MEDIA_PIPELINE_TIMEOUT = 5 * 60 * 1000`, `MAX_UPLOAD_SIZE = 100 * 1024 * 1024`)
- `PascalCase` (e.g., `Message`, `ChatRoom`, `FileInfo`, `LinkPreview`, `EnterKeyContext`)
- Prop interfaces: Named with `Props` suffix (e.g., `UserCardProps`)
- Enum values: `PascalCase` (e.g., `MessageStatus.sent`, `MessageType.text`)
- Refs: `camelCase` with `ref` suffix or self-documenting (e.g., `const fetchState = ref()`, `const data = ref()`)
- Computed properties: `camelCase` (e.g., `const isLoading = computed(...)`)
- Provide/inject keys: `UPPER_SNAKE_CASE` or enum (e.g., `EAppProviders.AppRoutes`)
## Code Style
- No explicit ESLint or Prettier config in repository — follows TypeScript strict mode
- Vue files use `<script setup lang="ts">` syntax (single-file components)
- TypeScript strict mode enabled (`"strict": true` in `tsconfig.json`)
- Module resolution: `bundler` (Vite-compatible)
- TypeScript strict checks enforced: exact type safety required
- No `any` types allowed in application code
- Vue component props must use `defineProps<Props>()` with TypeScript interface
- Composables — `.ts` modules (`use-*.ts`), не SFC; Vue UI — `<script setup lang="ts">`
## Import Organization
## Error Handling
- Errors are caught explicitly with `try-catch` blocks
- Error messages logged with context prefix (e.g., `console.error("[App] retry username failed:", e)`)
- User-facing errors provided via i18n keys (e.g., `t("register.nameTaken")`)
- Server/API errors narrowed safely: `if (e instanceof Error) { e.message } else { fallback }`
- `console.error()` and `console.warn()` used only for initialization/boot errors and unexpected failures
- Error logs prefixed with module name (e.g., `[App]`, `[AppInitializer]`, `[BOOT]`)
- No `console.log()` statements in production code — use composable error state instead
- Composables like `useAsyncOperation<TArgs, TResult>` manage loading states
- All async functions return promises or undefined
- Timeouts enforced via `withTimeout()` wrapper for long-running operations (e.g., media pipeline: 5min timeout)
## Vue 3 Composition API Usage
- State stored in `ref()` for single values
- State stored in `computed()` for derived/filtered data
- State stored in Pinia stores for shared application state (`useChatStore()`, `useAuthStore()`)
- No local state duplication from Pinia stores
- Vue lifecycle hooks imported from `vue` (e.g., `onMounted`, `onUnmounted`, `onScopeDispose`)
- Manual cleanup in composables uses `onScopeDispose()` or `return () => cleanup()`
- Example: `const { revokeAllFileUrls } = useFileDownload()` cleans up blob URLs
- `emit()` used for component events (never direct parent mutation)
- Event payload passed as tuple type: `defineEmits<{ select: [messageId: string] }>()`
- Click handlers use `@click.prevent` or `@click.stop` when needed
- Native events pass through template bindings: `@change`, `@submit`, `@contextmenu`
## Component Props
## CSS and Styling
- All styling via Tailwind utility classes
- No custom CSS unless absolutely necessary (use CSS custom properties instead)
- Theme: `useThemeStore` (`setTheme` / `toggleTheme`); fallback to system dark when unset
- Custom colors defined as CSS tokens in global styles
- Defined in global stylesheet for design tokens
- Used for component variants: `bg-color-bg-ac`, `text-text-on-bg-ac-color`
- Example: `class="bg-color-bg-ac text-text-on-bg-ac-color hover:bg-color-bg-ac-1"`
## Immutability
## Files and Modules
- Target 200-400 lines per file
- Maximum 800 lines before splitting
- Composables typically 40-100 lines
- Store modules typically 100-300 lines
- Tests co-located with implementation
## Comments and Documentation
- Non-obvious algorithms (e.g., "Clean up a cancelled upload: mark message, revoke blob, remove pending ops")
- Business logic that can't be expressed in code
- Workarounds or platform-specific quirks (e.g., "Electron's file:// protocol doesn't support crossorigin")
- TODOs and FIXMEs only for actual blocking issues
- Minimal — code should be self-documenting
- Only explain "why", not "what"
- Example: `// Prevent double invocation from both abort catch and cancelMediaUpload`
## Code Quality Checklist
- [ ] All functions have parameter and return types
- [ ] No `any` types (use `unknown` and narrow safely)
- [ ] Error handling with try-catch or explicit error states
- [ ] Composables return reactive refs/computed + functions
- [ ] Props defined with TypeScript interfaces
- [ ] Vue components use `<script setup lang="ts">`
- [ ] No relative imports across modules (use `@/` aliases)
- [ ] Immutable state updates (no direct mutations)
- [ ] Console.error/warn only for errors, use ref state for UI feedback
- [ ] Tests co-located with source files
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

## Pattern Overview
- Vertical feature slicing: each feature owns UI, business logic, and data access
- Single source of truth: Dexie IndexedDB (local-first)
- Reactive data binding through Vue 3 Composition API + Pinia stores
- Async operations deferred to background (sync engine, decryption worker)
- Matrix Protocol integration for decentralized chat with E2E encryption
## Layers
- Purpose: Bootstrap, route setup, global initialization, theme/locale setup
- Contains: `App.vue`, `providers/` (Pinia, router, theme), `model/` (boot status); entry script — `src/main.ts`
- Depends on: All other layers
- Used by: index.html (entry point via #app mount)
- Purpose: Route containers that assemble features + layouts
- Contains: `ChatPage.vue`, `LoginPage.vue`, `RegisterPage.vue`, `ProfilePage.vue`, `AppearancePage.vue` (`/settings/appearance`); settings hub — `widgets/sidebar/ui/SettingsPanel.vue`
- Depends on: Features, widgets, entities
- Used by: Vue Router (from `app/providers/router/`)
- Purpose: Composed surfaces combining features and UI components (sidebar, layouts, chat window, header)
- Contains: `ChatSidebar.vue`, `ChatWindow.vue`, `MainLayout.vue`, `AuthLayout.vue`, `ChatMenu.vue`
- Depends on: Features, shared UI, entities
- Used by: Pages
- Purpose: User-facing functionality with UI, state management, and composables
- Contains: `messaging/`, `auth/`, `contacts/`, `video-calls/`, `search/`, `invite/`, `user-management/`, `wallet/`, etc.
- Structure per feature: `ui/` (Vue components), `model/` (composables, stores), `index.ts` (barrel)
- Depends on: Entities, shared
- Used by: Pages, widgets, other features
- Purpose: Core domain logic, type definitions, Pinia stores for entity data
- Contains: `auth/`, `chat/`, `user/`, `matrix/`, `channel/`, `call/`, `media/`, `theme/`, `locale/`, `tor/`, `local-ai/`, `ai-chat/`
- Structure per entity: `model/` (Pinia stores, types), `lib/` (helpers), `index.ts` (barrel)
- Depends on: Shared lib
- Used by: Features, app providers
- Purpose: Infrastructure, UI primitives, database, API clients, composables
- Depends on: Nothing (only external libs)
- Used by: All other layers
## Data Flow
- **Server state (Matrix):** Pinia stores in `entities/` (auth, chat, user, call, channel, …) поверх Dexie SSOT
- **UI state:** Vue Composition API refs + reactive objects
- **Local storage:** сессии, theme, pinned/muted rooms, registration — через `useLocalStorage()` / прямые ключи
## Key Abstractions
- Purpose: Unified interface to local-first database and sync operations
- Contains: `ChatDatabase` (Dexie schema), `MessageRepository`, `RoomRepository`, `UserRepository`, `SyncEngine`, `EventWriter`, `DecryptionWorker`, `ListenedRepository`
- Pattern: Singleton per logged-in user; initialized on login, destroyed on logout
- Lifecycle: `initChatDb()` → operations → `closeChatDb()` or `deleteChatDb()`
- Purpose: Encapsulate Dexie table access with domain-aware queries
- Examples: `MessageRepository.writeOutbound()`, `RoomRepository.getOrCreateRoom()`, `UserRepository.upsert()`
- Key method: `useLiveQuery()` hook for reactive reads
- Purpose: Parse and atomically write Matrix events to Dexie
- Handles: message insertion, reactions, edits, redactions, read receipts
- Key: transactional writes to ensure consistency
- Purpose: FIFO outbound queue with exponential backoff + jitter
- Lifecycle: `processQueue()` runs after DB recovery; `setOnline(true/false)` pauses/resumes
- Retry strategy: exponential backoff up to 30s, eventually marks as "failed"
- Purpose: Wrapper around Matrix SDK and E2E crypto
- Contains: Matrix client service, room crypto instances, key management
- Key methods: `decryptEvent()`, `encryptEvent()`, `getRoomMembers()`, `fetchEventContext()`
- `useAuthStore()` — auth, sessions, Matrix init
- `useChatStore()` — rooms, active room, metadata
- `useUserStore()` — profiles / contacts
- `useCallStore()` — WebRTC calls
- `useChannelStore()` — channels
- `useThemeStore()` / `useLocaleStore()` / `useTorStore()` / `useMediaStore()` / local-ai & ai-chat stores
- Accessed via: `const store = useXyzStore()`
## Entry Points
- `src/main.ts` — mount `#app`, Buffer polyfill, boot errors
- `setupApp()` — create Vue app, AppLoading, `setupProviders()`, boot timeout
- `src/app/App.vue` — root after router ready
## Error Handling
- Boot errors → AppLoading stays mounted with error UI, user can retry
- SyncEngine failures → operations marked as "failed", user sees error in message, can retry manually
- Decryption failures → message shows as "[encrypted]", DecryptionWorker retries on network recovery
- Matrix SDK errors → logged to console, operation fails gracefully, store state updated to reflect error
- Boot events: `bootStatus.setStep()`, `bootStatus.setError()`
- Operations: `console.info()` / `console.warn()` with `[Module]` prefix
- Errors: `console.error()` with context
## Cross-Cutting Concerns
- Entry: `useAuthStore().login()` → derives Matrix credentials from private key
- Central: `authStore.matrixReady` flag gates all chat operations
- Matrix SDK initialized only after login; destroyed on logout
- Per-room: `Pcrypto` instance created per room after Matrix sync
- Outbound: `SyncEngine` encrypts before sending via `getRoomCrypto()`
- Inbound: `EventWriter` decrypts via `roomCrypto.decryptEvent()`
- Retry: `DecryptionWorker` handles failed decryptions with exponential backoff
- Outbound: `SyncEngine.setOnline()` pauses/resumes queue based on network state
- Inbound: Matrix SDK queues sync events; `useLiveQuery()` reads from Dexie
- No explicit sync trigger needed; app automatically catches up on reconnect
- Dexie triggers: `useLiveQuery()` hook observes table changes
- Vue reactivity: Pinia stores expose computed refs; components subscribe via composables
- Example: `const messages = useLiveQuery(() => getChatDb().messages.findByRoom(roomId))`
- CSS variable: `--keyboardheight` updated on native keyboard events + visualViewport
- Safe area: CSS custom properties for Capacitor status bar insets
- Electron: `is-electron` / `is-electron-mac` classes for drag-region styling
- `isNative` (Capacitor), `isElectron` (Electron) flags control feature conditionals
- Electron: Service Worker transport proxy for Matrix sync
- Native: Tor daemon (background), status bar, keyboard height, push notifications, share target
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

В `.claude/skills/` этого репозитория сейчас только:

| Skill | Description | Path |
|-------|-------------|------|
| device-ai-loop | On-device итерация багов local-ai через Capacitor/Android (Forta Chat как consumer). | `.claude/skills/device-ai-loop/SKILL.md` |
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
