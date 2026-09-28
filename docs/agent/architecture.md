# Architecture reference

Detail reference for [AGENTS.md](../../AGENTS.md). See also [local-first-architecture.md](../local-first-architecture.md), [architecture-data-flow.md](../architecture-data-flow.md), [webrtc-architecture.md](../webrtc-architecture.md).

## Pattern overview

- Vertical feature slicing (FSD): each feature owns UI, business logic, and data access
- Single source of truth: Dexie IndexedDB (local-first)
- Reactive data binding through Vue 3 Composition API + Pinia stores
- Async operations deferred to background (sync engine, decryption worker)
- Matrix protocol for decentralized chat with E2E encryption

## Layers

### `src/app/`
- Purpose: bootstrap, route setup, global initialization, theme/locale setup
- Contains: `App.vue`, `providers/` (Pinia, router, theme), `model/` (boot status); entry script `src/main.ts`
- Depends on all other layers; used by `index.html` (`#app` mount)

### `src/pages/`
- Purpose: route containers that assemble features + layouts
- Contains: `ChatPage.vue`, `LoginPage.vue`, `RegisterPage.vue`, `ProfilePage.vue`, `AppearancePage.vue` (`/settings/appearance`); settings hub is `widgets/sidebar/ui/SettingsPanel.vue`
- Depends on features, widgets, entities; used by Vue Router (`app/providers/router/`)

### `src/widgets/`
- Purpose: composed surfaces (sidebar, layouts, chat window, header)
- Contains: `ChatSidebar.vue`, `ChatWindow.vue`, `MainLayout.vue`, `AuthLayout.vue`, `ChatMenu.vue`
- Depends on features, shared UI, entities; used by pages

### `src/features/`
- Purpose: user-facing functionality with UI, state, composables
- Contains: `messaging/`, `auth/`, `contacts/`, `video-calls/`, `search/`, `invite/`, `user-management/`, `wallet/`, ...
- Structure per feature: `ui/` (components), `model/` (composables, stores), `index.ts` (barrel)
- Depends on entities, shared; used by pages, widgets, other features

### `src/entities/`
- Purpose: core domain logic, types, Pinia stores for entity data
- Contains: `auth/`, `chat/`, `user/`, `matrix/`, `channel/`, `call/`, `media/`, `theme/`, `locale/`, `tor/`, `local-ai/`, `ai-chat/`
- Structure per entity: `model/` (stores, types), `lib/` (helpers), `index.ts`
- Depends on shared lib; used by features, app providers

### `src/shared/`
- Purpose: infrastructure, UI primitives, database, API clients, composables
- Depends on external libs only; used by all layers

## Data flow

- **Server state (Matrix):** Pinia stores in `entities/` (auth, chat, user, call, channel, ...) on top of the Dexie SSOT
- **UI state:** Composition API refs + reactive objects
- **Local storage:** sessions, theme, pinned/muted rooms, registration via `useLocalStorage()` or direct keys

## Key abstractions

### Local database (`shared/lib/local-db/`)
- `ChatDatabase` (Dexie schema), `MessageRepository`, `RoomRepository`, `UserRepository`, `SyncEngine`, `EventWriter`, `DecryptionWorker`, `ListenedRepository`
- Singleton per logged-in user; `initChatDb()` on login, `closeChatDb()` / `deleteChatDb()` on logout

### Repositories
- Encapsulate Dexie table access with domain-aware queries: `MessageRepository.writeOutbound()`, `RoomRepository.getOrCreateRoom()`, `UserRepository.upsert()`
- Reactive reads through `useLiveQuery()`

### EventWriter
- Parses and atomically writes Matrix events to Dexie: messages, reactions, edits, redactions, read receipts; transactional writes

### SyncEngine
- FIFO outbound queue with exponential backoff + jitter (up to 30s, then "failed")
- `processQueue()` runs after DB recovery; `setOnline(true/false)` pauses/resumes

### Matrix service (`entities/matrix/`)
- Wrapper around the Matrix SDK and E2E crypto: client service, per-room crypto instances, key management
- `decryptEvent()`, `encryptEvent()`, `getRoomMembers()`, `fetchEventContext()`

### Pinia stores
- `useAuthStore()` (auth, sessions, Matrix init), `useChatStore()` (rooms, active room, metadata), `useUserStore()`, `useCallStore()` (WebRTC), `useChannelStore()`, `useThemeStore()`, `useLocaleStore()`, `useTorStore()`, `useMediaStore()`, local-ai and ai-chat stores

## Entry points

- `src/main.ts`: mounts `#app`, Buffer polyfill, boot errors
- `setupApp()`: creates the Vue app, AppLoading, `setupProviders()`, boot timeout
- `src/app/App.vue`: root after router ready

## Error handling

- Boot errors: AppLoading stays mounted with error UI and retry
- SyncEngine failures: operations marked "failed", user sees the error on the message and can retry
- Decryption failures: message shows as "[encrypted]", DecryptionWorker retries on network recovery
- Matrix SDK errors: logged, operation fails gracefully, store state reflects the error
- Boot events via `bootStatus.setStep()` / `bootStatus.setError()`; operations logged with `[Module]` prefix

## Cross-cutting concerns

- **Auth:** `useAuthStore().login()` derives Matrix credentials from the private key; `authStore.matrixReady` gates all chat operations; the SDK is initialized after login and destroyed on logout
- **Encryption:** per-room `Pcrypto` instance after Matrix sync; outbound encrypted in `SyncEngine` via `getRoomCrypto()`, inbound decrypted in `EventWriter`; `DecryptionWorker` retries with backoff
- **Offline sync:** `SyncEngine.setOnline()` follows network state; inbound events queue in the SDK; `useLiveQuery()` reads from Dexie; the app catches up on reconnect without an explicit trigger
- **Reactivity:** Dexie triggers `useLiveQuery()`; Pinia stores expose computed refs; example `const messages = useLiveQuery(() => getChatDb().messages.findByRoom(roomId))`
- **Mobile layout:** neither WebView resizes for the soft keyboard, so native code publishes the insets and CSS adapts. `--app-bottom-inset` (Android: max(IME, nav bar) from `MainActivity.injectAllCssVars`; iOS: keyboard height from `useIOSKeyboardCssVar`) drives the bottom padding of the blocks that hold a text field, through the `.safe-bottom` / `.safe-y` / `.safe-all` utilities — one rule for both platforms. Only those blocks move: the root shell stays `position: fixed; inset: 0`. Safe-area CSS custom properties for Capacitor; `is-electron` / `is-electron-mac` classes for drag regions
- **Platform flags:** `isNative` (Capacitor), `isElectron`; Electron uses a Service Worker transport proxy for Matrix sync; native has Tor daemon, status bar, keyboard height, push notifications, share target
