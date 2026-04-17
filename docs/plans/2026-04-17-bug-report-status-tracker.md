# Bug Report Status Tracker — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Показать пользователю плашку со списком его жалоб, которые разработчик закрыл на GitHub, и дать кнопки «Решена» / «Не решена» (reopen).

**Architecture:**
- В каждом создаваемом GitHub issue вшиваем скрытый маркер с SHA-256 хэшем Matrix-адреса пользователя (`<!-- reporter:<hash16> -->`) для восстановления списка жалоб после переустановки приложения.
- При запуске приложения и при обновлении билда — проверяем статус своих issue через GitHub search API (`q=repo:X+reporter:<hash>+state:closed`). Сравниваем с локально-подтверждёнными (`localStorage`) и показываем разницу в `BugReportStatusSheet` (bottom sheet).
- «Решена» — помечаем локально как acknowledged; «Не решена» — `PATCH /issues/{n}` c `state: "open"` + комментарий.

**Tech Stack:** Vue 3 Composition API, TypeScript, Pinia (`useAuthStore`), Vitest + @vue/test-utils + happy-dom, Web Crypto API (`crypto.subtle.digest`) для SHA-256, GitHub REST API (PAT в `VITE_BUG_REPORT_TOKEN`), existing `BottomSheet.vue`, `useLocalStorage`.

**Repo:** `greenShirtMystery/forta-bugs` (уже используется в `bug-report-sender.ts`).

---

## Task 1: Добавить SHA-256 утилиту для reporter-hash

**Files:**
- Create: `src/shared/lib/bug-report/reporter-hash.ts`
- Test: `src/shared/lib/bug-report/__tests__/reporter-hash.test.ts`

**Step 1: Написать падающий тест**

```ts
// reporter-hash.test.ts
import { describe, it, expect } from 'vitest';
import { computeReporterHash, REPORTER_MARKER_PREFIX } from '../reporter-hash';

describe('computeReporterHash', () => {
  it('returns a 16-char lowercase hex string', async () => {
    const hash = await computeReporterHash('PNWnVB2kvNSf9ZE6vTJxyRgS3Pq4BBP7wp');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic for the same address', async () => {
    const a = await computeReporterHash('addr-1');
    const b = await computeReporterHash('addr-1');
    expect(a).toBe(b);
  });

  it('differs for different addresses', async () => {
    const a = await computeReporterHash('addr-1');
    const b = await computeReporterHash('addr-2');
    expect(a).not.toBe(b);
  });

  it('throws on empty address', async () => {
    await expect(computeReporterHash('')).rejects.toThrow();
  });
});

describe('REPORTER_MARKER_PREFIX', () => {
  it('is "reporter:"', () => {
    expect(REPORTER_MARKER_PREFIX).toBe('reporter:');
  });
});
```

**Step 2: Запустить — должно упасть**

Run: `npx vitest run src/shared/lib/bug-report/__tests__/reporter-hash.test.ts`
Expected: FAIL (no module).

**Step 3: Написать реализацию**

```ts
// reporter-hash.ts
export const REPORTER_MARKER_PREFIX = 'reporter:';

export async function computeReporterHash(address: string): Promise<string> {
  if (!address) throw new Error('address is required');
  const data = new TextEncoder().encode(`forta-bug-reporter:${address}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < 8; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export function buildReporterMarker(hash: string): string {
  return `<!-- ${REPORTER_MARKER_PREFIX}${hash} -->`;
}

export function extractReporterHashFromBody(body: string | undefined | null): string | null {
  if (!body) return null;
  const m = body.match(/<!--\s*reporter:([0-9a-f]{16})\s*-->/);
  return m ? m[1] : null;
}
```

Добавить тесты для `buildReporterMarker` / `extractReporterHashFromBody` в том же файле.

**Step 4: Запустить — должно пройти**

Run: `npx vitest run src/shared/lib/bug-report/__tests__/reporter-hash.test.ts`
Expected: PASS.

**Step 5: Коммит**

```bash
git add src/shared/lib/bug-report/reporter-hash.ts src/shared/lib/bug-report/__tests__/reporter-hash.test.ts
git commit -m "feat(bug-report): add reporter hash helper for anonymous user tracking"
```

---

## Task 2: Вшить reporter-hash в body отправляемого issue

**Files:**
- Modify: `src/shared/lib/bug-report/bug-report-sender.ts`
- Modify: `src/shared/lib/bug-report/types.ts` (добавить `reporterAddress?: string`)
- Modify: `src/shared/lib/bug-report/index.ts` (export новых утилит)
- Test: `src/shared/lib/bug-report/__tests__/bug-report-sender.test.ts`

**Step 1: Падающий тест**

Протестировать что `sendBugReport` с `reporterAddress` вкладывает `<!-- reporter:<hash> -->` в начало body отправляемого POST-запроса. Использовать `vi.stubGlobal('fetch', vi.fn())` + `vi.mock('import.meta.env', ...)` через `vi.stubEnv`.

```ts
// bug-report-sender.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendBugReport } from '../bug-report-sender';
import { computeReporterHash } from '../reporter-hash';

const fakeEnv = {
  platform: 'web', appVersion: '1.0.0', buildNumber: '1',
  webViewVersion: '', osVersion: '', deviceModel: '',
  screen: '1x1', locale: 'en', networkType: '',
  torStatus: '', matrixReady: false, currentRoute: '/',
  uptime: '0s', memoryMb: '0', userAgent: 'test',
} as const;

describe('sendBugReport', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_BUG_REPORT_TOKEN', 'test-token');
  });

  it('includes reporter marker when reporterAddress provided', async () => {
    const hash = await computeReporterHash('addr-1');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ html_url: 'https://github.com/x/y/issues/1', number: 1 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await sendBugReport({
      description: 'hello',
      environment: fakeEnv,
      reporterAddress: 'addr-1',
    });

    const body = JSON.parse(fetchMock.mock.calls.at(-1)![1].body);
    expect(body.body).toContain(`<!-- reporter:${hash} -->`);
  });

  it('omits marker when no address provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ html_url: 'x', number: 1 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await sendBugReport({ description: 'hi', environment: fakeEnv });

    const body = JSON.parse(fetchMock.mock.calls.at(-1)![1].body);
    expect(body.body).not.toContain('<!-- reporter:');
  });

  it('returns issueNumber in result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ html_url: 'x', number: 42 }),
    }));

    const res = await sendBugReport({ description: 'hi', environment: fakeEnv });
    expect(res.issueNumber).toBe(42);
  });
});
```

**Step 2: Запустить — должно упасть**

Run: `npx vitest run src/shared/lib/bug-report/__tests__/bug-report-sender.test.ts`
Expected: FAIL.

**Step 3: Реализация**

В `types.ts`:

```ts
export interface BugReportInput {
  description: string;
  environment: AppEnvironment;
  screenshots?: string[];
  /** Matrix/Bastyon address used to derive anonymous reporter hash */
  reporterAddress?: string;
}
```

В `bug-report-sender.ts`:

```ts
import { buildReporterMarker, computeReporterHash } from './reporter-hash';

// В formatBody добавить первым параметром optional reporterHash:
async function formatBody(
  input: BugReportInput,
  results: ScreenshotResult[],
): Promise<string> {
  const lines: string[] = [];
  if (input.reporterAddress) {
    const hash = await computeReporterHash(input.reporterAddress);
    lines.push(buildReporterMarker(hash), '');
  }
  // ... существующий код (убрать const lines = [...] → заменить на lines.push)
  return lines.join('\n');
}

// sendBugReport:
export interface BugReportResult {
  issueUrl: string;
  issueNumber: number;
  screenshotsFailed: number;
  uploadError?: string;
}

export async function sendBugReport(input: BugReportInput): Promise<BugReportResult> {
  // ...existing...
  const body = await formatBody(input, results);
  const res = await fetch(`${API_BASE}/repos/${REPO}/issues`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ title, body, labels: ['bug-report'] }),
  });
  // ...
  const data = await res.json();
  return {
    issueUrl: data.html_url as string,
    issueNumber: data.number as number,
    // ...
  };
}
```

В `index.ts` export:
```ts
export { computeReporterHash, buildReporterMarker, extractReporterHashFromBody } from './reporter-hash';
```

**Step 4: Тесты зелёные**

Run: `npx vitest run src/shared/lib/bug-report/__tests__/bug-report-sender.test.ts`
Expected: PASS.

**Step 5: Коммит**

```bash
git add -A src/shared/lib/bug-report/
git commit -m "feat(bug-report): embed reporter hash marker in issue body"
```

---

## Task 3: Bug-report tracker — клиент GitHub API + локальное хранилище

**Files:**
- Create: `src/shared/lib/bug-report/bug-report-tracker.ts`
- Test: `src/shared/lib/bug-report/__tests__/bug-report-tracker.test.ts`

**Step 1: Падающий тест**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchUserClosedIssues,
  reopenIssue,
  getAcknowledgedNumbers,
  acknowledgeIssue,
  clearAcknowledged,
  type TrackedIssue,
} from '../bug-report-tracker';

beforeEach(() => {
  vi.stubEnv('VITE_BUG_REPORT_TOKEN', 'test-token');
  localStorage.clear();
});

describe('fetchUserClosedIssues', () => {
  it('queries GitHub search API with reporter hash', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await fetchUserClosedIssues('addr-1');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/search/issues');
    expect(url).toContain('repo%3AgreenShirtMystery%2Fforta-bugs');
    expect(url).toContain('state%3Aclosed');
    expect(url).toMatch(/reporter%3A[0-9a-f]{16}/);
  });

  it('returns parsed TrackedIssue[]', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        items: [{
          number: 42,
          title: '[android] crash',
          html_url: 'https://github.com/x/y/issues/42',
          state: 'closed',
          closed_at: '2026-04-10T00:00:00Z',
          state_reason: 'completed',
        }],
      }),
    }));
    const issues = await fetchUserClosedIssues('addr-1');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      number: 42,
      title: '[android] crash',
      url: 'https://github.com/x/y/issues/42',
      stateReason: 'completed',
    });
  });

  it('returns [] on HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    const issues = await fetchUserClosedIssues('addr-1');
    expect(issues).toEqual([]);
  });
});

describe('acknowledgeIssue / getAcknowledgedNumbers', () => {
  it('persists acknowledgements per-address', async () => {
    acknowledgeIssue('addr-1', 1);
    acknowledgeIssue('addr-1', 2);
    acknowledgeIssue('addr-2', 3);
    expect(getAcknowledgedNumbers('addr-1').sort()).toEqual([1, 2]);
    expect(getAcknowledgedNumbers('addr-2')).toEqual([3]);
  });

  it('dedupes', () => {
    acknowledgeIssue('a', 1);
    acknowledgeIssue('a', 1);
    expect(getAcknowledgedNumbers('a')).toEqual([1]);
  });

  it('clearAcknowledged removes single', () => {
    acknowledgeIssue('a', 1);
    acknowledgeIssue('a', 2);
    clearAcknowledged('a', 1);
    expect(getAcknowledgedNumbers('a')).toEqual([2]);
  });
});

describe('reopenIssue', () => {
  it('PATCHes issue with state=open and posts comment', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fetchMock);

    await reopenIssue(42, 'still broken after v1.2.3');

    const patchCall = fetchMock.mock.calls[0];
    expect(patchCall[1].method).toBe('PATCH');
    expect(JSON.parse(patchCall[1].body)).toMatchObject({ state: 'open' });

    const commentCall = fetchMock.mock.calls[1];
    expect(commentCall[0]).toContain('/42/comments');
    expect(JSON.parse(commentCall[1].body).body).toContain('still broken');
  });
});
```

**Step 2: Красные**

Run: `npx vitest run src/shared/lib/bug-report/__tests__/bug-report-tracker.test.ts`
Expected: FAIL.

**Step 3: Реализация**

```ts
// bug-report-tracker.ts
import { computeReporterHash } from './reporter-hash';
import { APP_NAME } from '@/shared/config';

const REPO = 'greenShirtMystery/forta-bugs';
const API_BASE = 'https://api.github.com';
const LS_ACK_KEY = (addr: string) => `${APP_NAME}:bug-report-ack:${addr}`;

export interface TrackedIssue {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed';
  closedAt: string | null;
  stateReason: 'completed' | 'not_planned' | 'reopened' | null;
}

function getToken(): string {
  const token = import.meta.env.VITE_BUG_REPORT_TOKEN;
  if (!token) throw new Error('Bug report token not configured');
  return token;
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

export async function fetchUserClosedIssues(address: string): Promise<TrackedIssue[]> {
  try {
    const token = getToken();
    const hash = await computeReporterHash(address);
    const query = `repo:${REPO} reporter:${hash} state:closed`;
    const url = `${API_BASE}/search/issues?q=${encodeURIComponent(query)}&per_page=50&sort=updated`;
    const res = await fetch(url, { headers: ghHeaders(token) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.items ?? []).map((it: any): TrackedIssue => ({
      number: it.number,
      title: it.title,
      url: it.html_url,
      state: it.state,
      closedAt: it.closed_at ?? null,
      stateReason: it.state_reason ?? null,
    }));
  } catch (e) {
    console.warn('[bug-report-tracker] fetchUserClosedIssues failed:', e);
    return [];
  }
}

export async function reopenIssue(issueNumber: number, comment: string): Promise<void> {
  const token = getToken();
  await fetch(`${API_BASE}/repos/${REPO}/issues/${issueNumber}`, {
    method: 'PATCH',
    headers: ghHeaders(token),
    body: JSON.stringify({ state: 'open', state_reason: 'reopened' }),
  });
  await fetch(`${API_BASE}/repos/${REPO}/issues/${issueNumber}/comments`, {
    method: 'POST',
    headers: ghHeaders(token),
    body: JSON.stringify({ body: comment }),
  });
}

export function getAcknowledgedNumbers(address: string): number[] {
  try {
    const raw = localStorage.getItem(LS_ACK_KEY(address));
    return raw ? (JSON.parse(raw) as number[]) : [];
  } catch {
    return [];
  }
}

export function acknowledgeIssue(address: string, issueNumber: number): void {
  const current = new Set(getAcknowledgedNumbers(address));
  current.add(issueNumber);
  localStorage.setItem(LS_ACK_KEY(address), JSON.stringify([...current]));
}

export function clearAcknowledged(address: string, issueNumber: number): void {
  const current = getAcknowledgedNumbers(address).filter((n) => n !== issueNumber);
  localStorage.setItem(LS_ACK_KEY(address), JSON.stringify(current));
}
```

**Step 4: Зелёные**

Run: `npx vitest run src/shared/lib/bug-report/__tests__/bug-report-tracker.test.ts`
Expected: PASS.

**Step 5: Коммит**

```bash
git add -A src/shared/lib/bug-report/
git commit -m "feat(bug-report): add tracker with github search + ack persistence"
```

---

## Task 4: Composable `use-bug-report-status`

**Files:**
- Create: `src/features/bug-report/model/use-bug-report-status.ts`
- Test: `src/features/bug-report/model/__tests__/use-bug-report-status.test.ts`

**Step 1: Падающий тест**

Тест проверяет:
- `checkStatuses(address)` фетчит закрытые issue и фильтрует уже-подтверждённые
- `confirmResolved(n)` сохраняет ack и убирает из списка
- `markUnresolved(n, reason)` зовёт `reopenIssue` и убирает из списка
- Триггер: если `lastCheckedVersion !== currentVersion` ИЛИ прошло >3 дней с `lastCheckedAt` — `shouldCheckOnBoot` === true

**Step 2 — Step 5:** Реализация, тесты, коммит. (Детали: composable хранит `pendingIssues: Ref<TrackedIssue[]>`, вызывает функции из tracker; триггер-хелпер читает/пишет `lastCheckedVersion`, `lastCheckedAt` в `localStorage`.)

Commit: `feat(bug-report): add status-check composable with version + interval triggers`

---

## Task 5: UI — `BugReportStatusSheet.vue`

**Files:**
- Create: `src/features/bug-report/ui/BugReportStatusSheet.vue`
- Modify: `src/features/bug-report/index.ts` — export
- Test: `src/features/bug-report/ui/__tests__/BugReportStatusSheet.test.ts`

**Дизайн (из rules/web/design-quality.md — избегать дефолтного card grid):**

- `BottomSheet` (есть в `src/shared/ui/bottom-sheet/BottomSheet.vue`) с заголовком «Твои жалобы» + подзаголовок «Разработчик отметил их как решённые. Проверь?»
- Список карточек: `#42 · [android] не работает кнопка ...` + две кнопки: «Решено ✓» (зелёный accent) и «Всё ещё баг» (тёмный)
- Линк-иконка → открывает `issueUrl` внешне
- Состояние loading: 3 skeleton-строки
- Пустой state не рендерим — просто не показываем sheet
- Кнопка «Позже» в хедере — просто закрыть (не ack)

**Тест:** проверяет рендер списка, клик «Решено» зовёт composable.confirmResolved, клик «Всё ещё баг» показывает textarea для причины → submit зовёт markUnresolved.

Commit: `feat(bug-report): bottom sheet for reviewing closed issues`

---

## Task 6: Интеграция в SettingsPanel (где уже висит BugReportModal) + автотриггер в App.vue

**Files:**
- Modify: `src/widgets/sidebar/ui/SettingsPanel.vue` — также рендерить `BugReportStatusSheet`
- Modify: `src/features/bug-report/ui/BugReportModal.vue` — передавать `reporterAddress: authStore.address` в `sendBugReport` + после успешной отправки дёргать tracker для автопроверки
- Modify: `src/app/App.vue` (или `AppInitializer.vue` — найти через Grep) — после boot и если `authStore.address` есть → вызвать `checkStatuses(address)` через composable

**Step 1: Тест на интеграцию BugReportModal → reporterAddress в input**

```ts
// BugReportModal.test.ts (или добавить кейс)
// стаб useAuthStore({address:'addr-1'}), заполнить description, нажать send
// проверить что sendBugReport был вызван с reporterAddress: 'addr-1'
```

**Step 2-5:** Реализация + верификация + коммит.

Commit: `feat(bug-report): wire status tracker into app lifecycle`

---

## Task 7: i18n — ru / en

**Files:**
- Modify: `src/shared/lib/i18n/locales/ru.ts`
- Modify: `src/shared/lib/i18n/locales/en.ts`

Добавить:
```ts
bugReportStatus: {
  title: 'Твои жалобы',
  subtitle: 'Разработчик отметил эти жалобы как решённые. Всё действительно исправилось?',
  resolvedBtn: 'Решено',
  notResolvedBtn: 'Всё ещё баг',
  viewOnGithub: 'Посмотреть на GitHub',
  laterBtn: 'Позже',
  notResolvedReasonLabel: 'Что именно не так?',
  notResolvedSubmit: 'Переоткрыть жалобу',
  reopenedVia: 'Пользователь отметил жалобу как не решённую через приложение.',
  empty: '', // not used — sheet is hidden when empty
}
```

И en-аналог.

Commit: `feat(bug-report): i18n for status sheet`

---

## Task 8: Финальная верификация

- `npm run build`
- `npm run lint`
- `npx vue-tsc --noEmit`
- `npm run test`
- Agent `superpowers:code-reviewer` — архитектурный ревью

Если всё зелёное — создать коммит `chore(bug-report): status tracker integration` или merge commit + сообщить пользователю.

---

## DRY / YAGNI / осторожности

- **Не создавать отдельную Dexie-таблицу** — overhead миграций не оправдан для 1 списка чисел на аккаунт; `localStorage` достаточен.
- **Не добавлять pagination для search** — GitHub search выдаёт до 100 за запрос, у одного пользователя такого количества не будет.
- **Rate limit:** 30 req/min на search (без auth), 5000 req/hr (с auth). Триггерим раз в 3 дня / при новой версии — никак не упрёмся.
- **Приватность:** хэш не обратим; маркер в body публичного repo — это тоже знает пользователь при отправке.
- **Миграция:** существующие 200+ issue без маркера — не мигрируем (невозможно, они уже анонимны). Плашка заработает только для **новых** жалоб (которые были созданы после деплоя этой фичи).
