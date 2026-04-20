import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  shouldCheckOnBoot,
  markBootCheckCompleted,
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

describe('loadAllIssues (local cache only)', () => {
  it('reads per-address localStorage entries sorted by number desc', () => {
    trackCreatedIssue('addr-1', { number: 10, title: '[web] a' });
    trackCreatedIssue('addr-1', { number: 12, title: '[web] c' });
    trackCreatedIssue('addr-1', { number: 11, title: '[web] b' });

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

  it('isolates per-address data', () => {
    trackCreatedIssue('a', { number: 1, title: 't' });
    trackCreatedIssue('b', { number: 2, title: 't' });

    const status = useBugReportStatus();
    status.loadAllIssues('a');
    expect(status.allIssues.value.map((i) => i.number)).toEqual([1]);
    status.loadAllIssues('b');
    expect(status.allIssues.value.map((i) => i.number)).toEqual([2]);
  });
});

describe('useBugReportStatus actions', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_BUG_REPORT_TOKEN', 'test-token');
    trackCreatedIssue('addr-u', { number: 9, title: '[web] bug' });
  });

  it('markUnresolved calls GitHub PATCH+comment and updates local state', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fetchMock);

    const status = useBugReportStatus();
    status.loadAllIssues('addr-u');
    // Simulate that locally we think it's closed (e.g. user closed it earlier).
    const { updateLocalIssueState } = await import('@/shared/lib/bug-report');
    updateLocalIssueState('addr-u', 9, 'closed');
    status.loadAllIssues('addr-u');
    expect(status.allIssues.value[0].state).toBe('closed');

    const ok = await status.markUnresolved('addr-u', 9, 'still crashes');
    expect(ok).toBe(true);
    expect(status.allIssues.value[0].state).toBe('open');

    const patchCall = fetchMock.mock.calls.find(
      (c) => (c[1] as RequestInit).method === 'PATCH',
    );
    const postCall = fetchMock.mock.calls.find(
      (c) => (c[1] as RequestInit).method === 'POST',
    );
    expect(patchCall).toBeTruthy();
    expect(postCall).toBeTruthy();
    expect(
      JSON.parse((postCall![1] as RequestInit).body as string).body,
    ).toContain('still crashes');
  });

  it('markUnresolved returns false and keeps state when PATCH fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 403 })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) }),
    );

    const status = useBugReportStatus();
    status.loadAllIssues('addr-u');
    const beforeState = status.allIssues.value[0].state;

    const ok = await status.markUnresolved('addr-u', 9, 'noop');
    expect(ok).toBe(false);
    expect(status.allIssues.value[0].state).toBe(beforeState);
  });

  it('closeUserIssue PATCHes closed and updates local state', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fetchMock);

    const status = useBugReportStatus();
    status.loadAllIssues('addr-u');
    expect(status.allIssues.value[0].state).toBe('open');

    const ok = await status.closeUserIssue('addr-u', 9, 'figured it out');
    expect(ok).toBe(true);
    expect(status.allIssues.value[0].state).toBe('closed');

    const patchCall = fetchMock.mock.calls.find(
      (c) => (c[1] as RequestInit).method === 'PATCH',
    );
    expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toMatchObject({
      state: 'closed',
    });
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
