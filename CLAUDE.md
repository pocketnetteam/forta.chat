# Project Rules

## Стек

Vue 3 (Composition API) + Pinia + TypeScript + Vite + Vitest + Capacitor (mobile). Matrix SDK (matrix-js-sdk-bastyon) для коммуникации. Dexie (IndexedDB) для local-first хранения. WebRTC для видеозвонков.

## Архитектура

Feature-Sliced Design (FSD):
- `src/shared/` — утилиты, UI-компоненты, composables, local-db (Dexie)
- `src/entities/` — бизнес-сущности (chat, matrix, auth, user)
- `src/features/` — фичи (messaging, contacts, video-calls, auth)
- `src/app/` — точка входа, провайдеры, роутинг

Ключевые решения:
- **Dexie = single source of truth** — все данные читаются из IndexedDB через `useLiveQuery`
- **SyncEngine** (`shared/lib/local-db/sync-engine.ts`) — offline-first очередь отправки (FIFO, exponential backoff + jitter)
- **EventWriter** (`shared/lib/local-db/event-writer.ts`) — транзакционная запись событий Matrix → Dexie
- **ChatVirtualScroller** (`shared/ui/ChatVirtualScroller.vue`) — кастомный виртуальный скролл (column-reverse)

## Коммит конвенции

Conventional Commits: `fix:`, `feat:`, `docs:`, `refactor:`, `test:`, `perf:`, `chore:`

## Git Worktree Isolation (ОБЯЗАТЕЛЬНО)

Любая работа над фичей или багфиксом ДОЛЖНА выполняться в изолированном git worktree.

- Перед началом реализации фичи или фикса бага — создай worktree через `isolation: "worktree"` при запуске агентов или через EnterWorktree.
- Это нужно потому что несколько сессий Claude Code работают параллельно в одном проекте и без изоляции они конфликтуют друг с другом.
- НЕ делай изменения напрямую в основном рабочем дереве для задач разработки.
- Исключения: мелкие правки конфигов, обновление документации, коммиты — можно в основном дереве.

## Верификация перед коммитом (ОБЯЗАТЕЛЬНО)

После завершения каждой задачи обязательно прогонять полную верификацию перед коммитом:

1. `npm run build` — сборка (vue-tsc + vite)
2. `npm run lint` — линтер
3. `npx vue-tsc --noEmit` — проверка типов
4. `npm run test` — тесты

5. Code review агент (`superpowers:code-reviewer`) — архитектурный ревью изменений

Не коммитить, пока все проверки не пройдены.

## Тесты (ОБЯЗАТЕЛЬНО)

Каждая фича/багфикс ОБЯЗАТЕЛЬНО сопровождается тестами (unit + регрессионные). Фича без тестов не считается завершённой.

## Финальная верификация (ОБЯЗАТЕЛЬНО)

Перед коммитом/PR активировать для финальной проверки:

- Code review — выбирать по масштабу изменений:
  - `review` — для обычных задач (архитектурный ревью)
  - `review-fix` — для крупных изменений (7 ревьюеров + автофикс)
  - `review-team` — для PR перед мержем (5 агентов + Devil's Advocate)

<!-- GSD:project-start source:PROJECT.md -->
## Project

**Forta Chat — Android Compatibility Audit & Fix**

Системный аудит и исправление Android-специфичных багов в Forta Chat — мессенджере на Vue 3 + Capacitor. На части Android-устройств пользователи сталкиваются с лагами анимаций, неработающими кнопками, сломанной навигацией и отсутствием звука в звонках. Цель — добиться одинаково стабильной работы на всех поддерживаемых Android-устройствах.

**Core Value:** Приложение должно работать одинаково хорошо на любом Android-устройстве — без прыгающего UI, без неработающих кнопок, без пропадающего звука.

### Constraints

- **Устройства**: Поддержка Android 7.0+ (minSdk 24) — нужно учитывать старые WebView
- **Подход**: Только фикс/оптимизация — без рефакторинга ради рефакторинга
- **Данные**: Ориентируемся на жалобы пользователей, нет лабораторных устройств для тестирования
- **Параллельная работа**: Другой разработчик работает над клавиатурой — не пересекаться
<!-- GSD:project-end -->

<!-- GSD:stack-start source:codebase/STACK.md -->
## Technology Stack

## Languages
- TypeScript 5.5.4 - All source code (`src/**/*.ts`, `src/**/*.tsx`, `src/**/*.vue`)
- JavaScript (CommonJS) - Electron main process (`electron/main.cjs`, `electron/preload.cjs`)
- Vue 3 (.vue single-file components) - UI layer (`src/**/*.vue`)
- CSS - Tailwind-based styling (via Tailwind config)
- HTML - Template markup within Vue SFCs
## Runtime
- Node.js (inferred from npm/package-lock.json)
- Browser (Web/Electron via Chromium)
- Android (via Capacitor 8.2.0)
- npm - Primary package manager
- Lockfile: `package-lock.json` (present)
## Frameworks
- Vue 3.4.31 (Composition API) - UI framework
- Vite 5.3.4 - Build tool and dev server
- Vue Router 4 - Client-side routing
- Pinia 2.2.0 - Global state management (Vuex replacement)
- Dexie 4.3.0 - IndexedDB wrapper for local-first data persistence
- TailwindCSS 3.4.7 - Utility-first CSS framework
- unplugin-vue-components 0.27.3 - Auto-imports UI components from `src/shared/ui`
- class-variance-authority 0.7.0 - CSS variant composition
- Vitest 4.0.18 - Unit/integration test runner
- @vue/test-utils 2.4.6 - Vue component testing utilities
- happy-dom 20.6.2 - Lightweight DOM implementation for tests
- fake-indexeddb 6.2.5 - IndexedDB mock for testing
- Electron 40.6.0 - Desktop app framework (main + preload)
- electron-builder 26.8.1 - Electron packaging and distribution
- TypeScript compiler (via `vue-tsc 2.0.26`) - Type checking
- Terser 5.46.0 - JavaScript minification
- unplugin-auto-import 0.18.2 - Auto-imports common utilities (vue, vue-router, i18n)
## Key Dependencies
- matrix-js-sdk-bastyon 23.2.4 - Matrix client library (forked Bastyon version) for chat protocol
- @capacitor/core 8.2.0 - Native bridge for Android/iOS features
- axios 0.21.4 - HTTP client (used by Matrix SDK wrapper)
- zod 3.23.8 - Schema validation and type inference
- @noble/secp256k1 2.3.0 - ECDSA signing (Bastyon address derivation)
- pbkdf2 3.1.2 - Key derivation function
- create-hash 1.2.0 - Hash primitives (polyfill)
- bn.js 5.2.0 - Big number arithmetic
- miscreant 0.3.2 - AEAD encryption (forta-crypto compatibility)
- @capacitor/camera 8.0.2 - Photo/camera capture on native
- @capacitor/filesystem 8.1.2 - File system access (native)
- @capacitor/share 8.0.1 - Native share dialog
- @capgo/capacitor-share-target 8.0.25 - Receive shared files from Android
- file-saver 2.0.5 - Download files to user device
- audio-recorder-polyfill 0.4.1 - Audio recording (with polyfill for browsers)
- socks-proxy-agent 8.0.5 - SOCKS5 proxy support (Tor integration)
- node-fetch 2.7.0 - Fetch polyfill for Node.js contexts
- emoji-kitchen-mart 6.0.5 - Emoji reactions database
- virtua 0.48.8 - Virtual list component
- vue-virtual-scroller 2.0.0-beta.8 - Virtual scrolling for large chat lists
- vee-validate 4.13.2 - Form validation framework
- @vee-validate/zod 4.13.2 - Zod integration with vee-validate
- qs 6.10.3 - Query string serialization (used by Matrix SDK)
- tar 7.5.9 - TAR archive support
- @capacitor/push-notifications 8.0.2 - Push notification handling
- @capacitor/local-notifications 8.0.2 - Local/scheduled notifications
- @capacitor/haptics 8.0.1 - Haptic feedback (native)
- @capacitor/app 8.0.1 - App lifecycle handling
- @capacitor/status-bar 8.0.1 - Status bar control
- @capacitor/local-notifications 8.0.2 - Local notification scheduling
- tree-kill 1.2.2 - Process cleanup (dev)
- concurrently 9.2.1 - Run multiple npm scripts in parallel
- buffer 6.0.3 - Node.js Buffer polyfill
- stream-browserify 3.0.0 - Node.js stream polyfill
## Configuration
- Variables loaded from `.env` (via Vite's `import.meta.env`)
- Critical env vars (see INTEGRATIONS.md):
- `vite.config.ts` - Main build configuration
- `tsconfig.json` - TypeScript strict mode, path aliases (@/, @app/, @entities/, etc.)
- `tailwind.config.js` - Theme tokens using CSS custom properties
- `vitest.config.ts` - Vitest settings (happy-dom environment, `src/**/*.test.ts` pattern)
- `capacitor.config.ts` - Capacitor configuration
## Platform Requirements
- Node.js 18+ (inferred from TypeScript ES2020 target)
- npm 7+ (lockfile v2)
- TypeScript 5.5.4 (strict mode enabled)
- Modern browser supporting:
- Android 7.0+ (API level 24+)
- Capacitor 8.2.0
- Windows 10+, macOS 10.13+, Linux (glibc 2.28+)
- Chromium 126+ (via Electron 40.6.0)
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
- Composables must use `<script setup>` syntax
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
- Dark mode not explicitly toggled — relies on system/browser defaults
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
- Contains: `main.ts` (entry), `App.vue` (root component), `providers/` (Pinia, router, theme), `model/` (boot status)
- Depends on: All other layers
- Used by: index.html (entry point via #app mount)
- Purpose: Route containers that assemble features + layouts
- Contains: `ChatPage.vue`, `LoginPage.vue`, `RegisterPage.vue`, `ProfilePage.vue`, `SettingsPage.vue`, etc.
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
- Contains: `auth/`, `chat/`, `user/`, `matrix/`, `channel/`, `call/`, `media/`, `theme/`, `locale/`, `tor/`
- Structure per entity: `model/` (Pinia stores, types), `lib/` (helpers), `index.ts` (barrel)
- Depends on: Shared lib
- Used by: Features, app providers
- Purpose: Infrastructure, UI primitives, database, API clients, composables
- Substructure:
- Depends on: Nothing (only external libs)
- Used by: All other layers
## Data Flow
- **Server state (Matrix):** Pinia stores in `entities/` (auth, chat, user, call, channel)
- **UI state:** Vue Composition API refs + reactive objects (no Pinia)
- **Local storage:** Session data persisted in `localStorage` via `useLocalStorage()` helper
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
- `useAuthStore()` — auth state, session management, Matrix init
- `useChatStore()` — rooms, active room, room metadata
- `useUserStore()` — user profiles, contact info
- `useCallStore()` — call state, WebRTC connections
- `useChannelStore()` — channel subscriptions
- Accessed via: Vue Composition API `const store = useXyzStore()`
## Entry Points
- Location: Project root entry
- Triggers: Called by HTML `<script>` tag
- Responsibilities: Mount Vue app to #app, polyfill globals (Buffer), handle boot errors
- Location: Bootstrap function called by `main.ts`
- Triggers: Async initialization via `setupApp()`
- Responsibilities: Create Vue app, mount AppLoading overlay, call `setupProviders()`, handle boot timeout, return mounted app or null on error
- Location: Provider orchestration
- Triggers: Called during app boot
- Responsibilities:
- Location: Root Vue component
- Triggers: Mounted after router ready
- Responsibilities:
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

| Skill | Description | Path |
|-------|-------------|------|
| develop-team | This skill should be used when the user asks to "develop a feature", "implement a ticket", "build BAST-123", "run the development pipeline", "develop this ticket end to end", or wants fully autonomous feature implementation with parallel research agents, planning, phased implementation, review, and PR creation. Zero checkpoints; pauses only on blockers. | `.claude/skills/develop-team/SKILL.md` |
| fix-ticket | "Automate the full Linear bug-fix pipeline end-to-end. Use when the user says 'fix ticket', 'fix BAST-123', 'fix this bug', 'resolve BAST-XXX', 'fix and ship this ticket', or passes a Linear ticket ID for autonomous bug resolution. Reads the Linear ticket, implements the fix, reviews it, commits, updates the ticket status, and comments with a summary. Also use when the user wants to automate the fix-review-commit-handoff cycle for any Linear bug ticket." | `.claude/skills/fix-ticket/SKILL.md` |
| review-fix | Automated review-fix loop that spawns 7 reviewers in parallel, fixes quick-fix items automatically, and accumulates strategic items for user decision. Iterates until no issues remain or max iterations reached. Adapted for Vue 3 + TypeScript + Pinia codebase. | `.claude/skills/review-fix/SKILL.md` |
| review-team | Agent Teams PR review with Devil's Advocate. Spawns 5 team members — 4 specialist reviewers + 1 adversarial challenger — to produce confidence-rated findings. Only findings that survive cross-examination make the final report. Adapted for Vue 3 + TypeScript + Pinia with Linear ticket integration. | `.claude/skills/review-team/SKILL.md` |
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
