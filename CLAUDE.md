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
