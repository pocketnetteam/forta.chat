// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  shouldCheckOnBoot,
  markBootCheckCompleted,
  hasManageableIssue,
  useBugReportStatus,
} from '../use-bug-report-status';
import { trackCreatedIssue } from '@/shared/lib/bug-report';

const APP_NAME = 'forta-chat';
const CHECKED_AT_KEY = `${APP_NAME}:bug-report-status:last-checked-at`;

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-17T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  useBugReportStatus().resetState();
});

describe('shouldCheckOnBoot', () => {
  it('returns true on first run (no timestamp stored)', () => {
    expect(shouldCheckOnBoot()).toBe(true);
  });

  it('returns false when <2 days elapsed since last check', () => {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    localStorage.setItem(CHECKED_AT_KEY, JSON.stringify(oneDayAgo));
    expect(shouldCheckOnBoot()).toBe(false);
  });

  it('returns true when >2 days elapsed since last check', () => {
    const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
    localStorage.setItem(CHECKED_AT_KEY, JSON.stringify(threeDaysAgo));
    expect(shouldCheckOnBoot()).toBe(true);
  });

  it('returns false right after markBootCheckCompleted (app update should not re-trigger)', () => {
    markBootCheckCompleted();
    expect(shouldCheckOnBoot()).toBe(false);
  });
});

describe('markBootCheckCompleted', () => {
  it('persists timestamp', () => {
    markBootCheckCompleted();
    expect(typeof JSON.parse(localStorage.getItem(CHECKED_AT_KEY)!)).toBe(
      'number',
    );
    expect(shouldCheckOnBoot()).toBe(false);
  });
});

describe('hasManageableIssue', () => {
  it('asks on boot only when some report can be closed or reopened', () => {
    trackCreatedIssue('addr-1', { number: 1, title: 'new', manageKey: 'k', url: null });
    localStorage.setItem(
      'forta-chat:bug-report-mine:addr-2',
      JSON.stringify([{ number: 2, title: 'old', createdAt: '2026-01-01T00:00:00Z', lastKnownState: 'open' }]),
    );
    const status = useBugReportStatus();
    status.loadAllIssues('addr-1');
    expect(hasManageableIssue(status.allIssues.value)).toBe(true);
    status.loadAllIssues('addr-2');
    expect(hasManageableIssue(status.allIssues.value)).toBe(false);
    expect(hasManageableIssue([])).toBe(false);
  });

  it('treats a manage key that is not a string as none', () => {
    localStorage.setItem(
      'forta-chat:bug-report-mine:addr-3',
      JSON.stringify([{ number: 3, title: 'bad', createdAt: '2026-01-01T00:00:00Z', lastKnownState: 'open', manageKey: 123 }]),
    );
    const status = useBugReportStatus();
    status.loadAllIssues('addr-3');
    expect(status.allIssues.value[0].canManage).toBe(false);
  });
});

describe('loadAllIssues (local cache only)', () => {
  it('reads per-address localStorage entries sorted by number desc', () => {
    trackCreatedIssue('addr-1', { number: 10, title: '[web] a', manageKey: 'k', url: null });
    trackCreatedIssue('addr-1', { number: 12, title: '[web] c', manageKey: 'k', url: null });
    trackCreatedIssue('addr-1', { number: 11, title: '[web] b', manageKey: 'k', url: null });

    const { loadAllIssues, allIssues } = useBugReportStatus();
    loadAllIssues('addr-1');

    expect(allIssues.value.map((i) => i.number)).toEqual([12, 11, 10]);
    expect(allIssues.value[0].state).toBe('open');
  });

  it('returns empty list for empty address', () => {
    const { loadAllIssues, allIssues } = useBugReportStatus();
    loadAllIssues('');
    expect(allIssues.value).toEqual([]);
  });

  it('lets the user act only on reports the proxy gave a key for', () => {
    trackCreatedIssue('addr-1', { number: 20, title: 'new', manageKey: 'k', url: 'https://github.com/o/r/issues/20' });
    // Sent before the proxy: no key, no link in the cache (audit S10-06).
    localStorage.setItem(
      'forta-chat:bug-report-mine:addr-1',
      JSON.stringify([
        ...JSON.parse(localStorage.getItem('forta-chat:bug-report-mine:addr-1')!),
        { number: 3, title: 'old', createdAt: '2026-01-01T00:00:00Z', lastKnownState: 'open' },
      ]),
    );

    const { loadAllIssues, allIssues } = useBugReportStatus();
    loadAllIssues('addr-1');

    expect(allIssues.value.map((i) => [i.number, i.canManage, i.url])).toEqual([
      [20, true, 'https://github.com/o/r/issues/20'],
      [3, false, 'https://github.com/greenShirtMystery/forta-bugs/issues/3'],
    ]);
  });

  it('isolates per-address data', () => {
    trackCreatedIssue('a', { number: 1, title: 't', manageKey: 'k', url: null });
    trackCreatedIssue('b', { number: 2, title: 't', manageKey: 'k', url: null });

    const status = useBugReportStatus();
    status.loadAllIssues('a');
    expect(status.allIssues.value.map((i) => i.number)).toEqual([1]);
    status.loadAllIssues('b');
    expect(status.allIssues.value.map((i) => i.number)).toEqual([2]);
  });
});

describe('useBugReportStatus actions', () => {
  const KEY = '0123456789abcdef0123456789abcdef';

  beforeEach(() => {
    vi.stubEnv('VITE_BUG_REPORT_ENDPOINT', 'https://bugs.test');
    trackCreatedIssue('addr-u', { number: 9, title: '[web] bug', manageKey: KEY, url: null });
  });

  function sent(fetchMock: ReturnType<typeof vi.fn>): { url: string; payload: Record<string, unknown> } {
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    return { url, payload: JSON.parse(init.body as string) };
  }

  it('markUnresolved asks the proxy with the manage key and updates local state', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const status = useBugReportStatus();
    // Simulate that locally we think it's closed (e.g. user closed it earlier).
    const { updateLocalIssueState } = await import('@/shared/lib/bug-report');
    updateLocalIssueState('addr-u', 9, 'closed');
    status.loadAllIssues('addr-u');
    expect(status.allIssues.value[0].state).toBe('closed');

    const ok = await status.markUnresolved('addr-u', 9, 'still crashes');
    expect(ok).toBe(true);
    expect(status.allIssues.value[0].state).toBe('open');

    const { url, payload } = sent(fetchMock);
    expect(url).toBe('https://bugs.test/v1/reports/9/state');
    expect(payload).toMatchObject({ state: 'open', manageKey: KEY });
    expect(payload.comment).toContain('still crashes');
  });

  it('markUnresolved returns false and keeps state when the proxy refuses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));

    const status = useBugReportStatus();
    status.loadAllIssues('addr-u');
    const beforeState = status.allIssues.value[0].state;

    const ok = await status.markUnresolved('addr-u', 9, 'noop');
    expect(ok).toBe(false);
    expect(status.allIssues.value[0].state).toBe(beforeState);
  });

  it('closeUserIssue asks the proxy to close and updates local state', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const status = useBugReportStatus();
    status.loadAllIssues('addr-u');
    expect(status.allIssues.value[0].state).toBe('open');

    const ok = await status.closeUserIssue('addr-u', 9, 'figured it out');
    expect(ok).toBe(true);
    expect(status.allIssues.value[0].state).toBe('closed');
    expect(sent(fetchMock).payload).toMatchObject({ state: 'closed', manageKey: KEY });
  });

  it('does not call the proxy for a report without a manage key', async () => {
    localStorage.setItem(
      'forta-chat:bug-report-mine:addr-old',
      JSON.stringify([{ number: 4, title: 'old', createdAt: '2026-01-01T00:00:00Z', lastKnownState: 'open' }]),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await useBugReportStatus().closeUserIssue('addr-old', 4, '')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resetState clears list, loading, sheet', () => {
    const status = useBugReportStatus();
    status.loadAllIssues('addr-u');
    status.openSheet();
    expect(status.allIssues.value).toHaveLength(1);
    expect(status.sheetOpen.value).toBe(true);
    status.resetState();
    expect(status.allIssues.value).toHaveLength(0);
    expect(status.sheetOpen.value).toBe(false);
  });
});
