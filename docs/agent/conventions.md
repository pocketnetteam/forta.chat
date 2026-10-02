# Code conventions

Detail reference for [AGENTS.md](../../AGENTS.md).

## Naming

- Vue components: `PascalCase` (`Button.vue`, `MediaGrid.vue`, `ChatVirtualScroller.vue`)
- Composables/hooks: `kebab-case` with `use-` prefix (`use-async-operation.ts`, `use-toast.ts`, `use-file-download.ts`)
- Utilities: `kebab-case` files (`promise-pool.ts`, `message-format.ts`); exported functions and methods in `camelCase`
- Tests: `kebab-case.test.ts` co-located with source (`use-messages.test.ts` next to `use-messages.ts`)
- Directories: `kebab-case`, organized by feature or domain (`shared/lib/`, `features/messaging/`, `entities/chat/`)
- Booleans: prefixed with `is`, `has`, `should`, `can` (`isLoading`, `hasError`, `shouldSendOnEnter`, `canJoinRoom`)
- Async functions: `async`/`await` (`refresh()`, `sendMessage()`, `toggleReaction()`)
- Event handlers: prefixed with `handle` or `on` (`handleRetryUsername`, `handleUploadCancelled`, `onMounted`)
- Constants: `UPPER_SNAKE_CASE` for globally accessible constants; descriptive inline constants (`MEDIA_PIPELINE_TIMEOUT = 5 * 60 * 1000`, `MAX_UPLOAD_SIZE = 100 * 1024 * 1024`)
- Types/interfaces: `PascalCase` (`Message`, `ChatRoom`, `FileInfo`, `LinkPreview`, `EnterKeyContext`); prop interfaces end with `Props` (`UserCardProps`)
- Enum values: `PascalCase` (`MessageStatus.sent`, `MessageType.text`)
- Refs: `camelCase`, self-documenting (`const fetchState = ref()`); computed: `camelCase` (`const isLoading = computed(...)`)
- Provide/inject keys: `UPPER_SNAKE_CASE` or enum (`EAppProviders.AppRoutes`)

## Code style

- No ESLint or Prettier config in the repository; TypeScript strict mode is the gate (`"strict": true`, module resolution `bundler`)
- No `any` in application code (use `unknown` and narrow safely)
- Vue files use `<script setup lang="ts">`; props via `defineProps<Props>()` with a TypeScript interface
- Composables are `.ts` modules (`use-*.ts`), not SFCs
- No relative imports across modules (use `@/` aliases)

## Error handling

- Catch errors explicitly with `try-catch`; narrow safely: `if (e instanceof Error) { e.message } else { fallback }`
- Log with a module prefix (`console.error("[App] retry username failed:", e)`); prefixes like `[App]`, `[AppInitializer]`, `[BOOT]`
- `console.error()` / `console.warn()` only for initialization/boot errors and unexpected failures; no `console.log()` in production code, use composable error state instead
- User-facing errors go through i18n keys (`t("register.nameTaken")`)
- `useAsyncOperation<TArgs, TResult>` manages loading states; timeouts via `withTimeout()` for long operations (media pipeline: 5 min)

## Vue 3 Composition API

- `ref()` for single values, `computed()` for derived data, Pinia stores for shared state (`useChatStore()`, `useAuthStore()`); no local duplication of store state
- Lifecycle hooks imported from `vue` (`onMounted`, `onUnmounted`, `onScopeDispose`); cleanup via `onScopeDispose()` or a returned cleanup function (`useFileDownload().revokeAllFileUrls`)
- `emit()` for component events, never direct parent mutation; typed payloads: `defineEmits<{ select: [messageId: string] }>()`
- `@click.prevent` / `@click.stop` when needed; native events through template bindings (`@change`, `@submit`, `@contextmenu`)

## CSS and styling

- Tailwind utility classes; no custom CSS unless necessary (prefer CSS custom properties)
- Theme via `useThemeStore` (`setTheme` / `toggleTheme`); falls back to system dark when unset
- Design tokens are CSS variables in the global stylesheet; variant classes like `bg-color-bg-ac text-text-on-bg-ac-color hover:bg-color-bg-ac-1`

## Files and modules

- Target 200-400 lines per file, split at 800
- Composables typically 40-100 lines; store modules 100-300 lines
- Tests co-located with implementation

## Tests

- Files run in parallel, one forked process per file; the default environment is plain Node. A file that needs browser APIs (`document`, `window`, `localStorage`, `location`, `@vue/test-utils` `mount`) starts with `// @vitest-environment happy-dom`. `document is not defined` and similar errors mean the line is missing.
- Keep files that don't need a DOM in Node: building a happy-dom window costs ~0.7 s per file.
- Fake timers (`vi.useFakeTimers()`) instead of real waits: a test that sleeps for seconds slows every run.
- While iterating, run only the test files you touch: `npx vitest run path/to/a.test.ts path/to/b.test.ts` (seconds). Run the full `npm run test` (~2 min) once before commit. `vitest related` / `--changed` do not help here: almost every module reaches `chat-store`, so they select ~100 files.
- From an agent's shell, run the full suite in the background or with a 10-minute timeout. A shell killed by a short timeout leaves `vitest` orphaned; such a run never finishes (its pool keeps restarting the worker). Don't start a second full run while one is going; check for leftover `node ... vitest.mjs run` processes first.

## Comments

- Minimal; code should be self-documenting. Explain "why", not "what"
- Comment non-obvious algorithms, business logic that code cannot express, platform quirks (`// Electron's file:// protocol doesn't support crossorigin`), and real blocking TODO/FIXME only

## Quality checklist

- [ ] All functions have parameter and return types
- [ ] No `any` types
- [ ] Error handling with try-catch or explicit error states
- [ ] Composables return reactive refs/computed + functions
- [ ] Props defined with TypeScript interfaces; components use `<script setup lang="ts">`
- [ ] No relative imports across modules
- [ ] Immutable state updates (no direct mutations)
- [ ] `console.error`/`warn` only for errors; ref state for UI feedback
- [ ] Tests co-located with source files
