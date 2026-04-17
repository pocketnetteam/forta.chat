import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  shouldCheckOnBoot,
  markBootCheckCompleted,
  resetBootCheckMeta,
  useBugReportStatus,
} from '../use-bug-report-status';

const APP_NAME = 'forta-chat';
const VERSION_KEY = `${APP_NAME}:bug-report-status:last-version`;
const CHECKED_AT_KEY = `${APP_NAME}:bug-report-status:last-checked-at`;

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-17T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('shouldCheckOnBoot', () => {
  it('returns true on first run (no metadata stored)', () => {
    expect(shouldCheckOnBoot('1.0.0')).toBe(true);
  });

  it('returns true when app version changed', () => {
    localStorage.setItem(VERSION_KEY, JSON.stringify('1.0.0'));
    localStorage.setItem(
      CHECKED_AT_KEY,
      JSON.stringify(Date.now()),
    );
    expect(shouldCheckOnBoot('1.1.0')).toBe(true);
  });

  it('returns false when version same and <3 days since last check', () => {
    localStorage.setItem(VERSION_KEY, JSON.stringify('1.0.0'));
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    localStorage.setItem(CHECKED_AT_KEY, JSON.stringify(oneDayAgo));
    expect(shouldCheckOnBoot('1.0.0')).toBe(false);
  });

  it('returns true when >3 days since last check', () => {
    localStorage.setItem(VERSION_KEY, JSON.stringify('1.0.0'));
    const fourDaysAgo = Date.now() - 4 * 24 * 60 * 60 * 1000;
    localStorage.setItem(CHECKED_AT_KEY, JSON.stringify(fourDaysAgo));
    expect(shouldCheckOnBoot('1.0.0')).toBe(true);
  });

  it('treats empty version string as first run', () => {
    expect(shouldCheckOnBoot('')).toBe(true);
  });
});

describe('markBootCheckCompleted', () => {
  it('persists version + timestamp', () => {
    markBootCheckCompleted('1.2.3');
    expect(JSON.parse(localStorage.getItem(VERSION_KEY)!)).toBe('1.2.3');
    expect(typeof JSON.parse(localStorage.getItem(CHECKED_AT_KEY)!)).toBe(
      'number',
    );
    // Subsequent call with same version and no time elapsed → skip
    expect(shouldCheckOnBoot('1.2.3')).toBe(false);
  });
});

describe('resetBootCheckMeta', () => {
  it('clears persisted metadata', () => {
    markBootCheckCompleted('1.0.0');
    resetBootCheckMeta();
    expect(shouldCheckOnBoot('1.0.0')).toBe(true);
  });
});

describe('useBugReportStatus actions', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_BUG_REPORT_TOKEN', 'test-token');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    // Reset singleton state between tests
    const { pendingIssues, closeSheet } = useBugReportStatus() as any;
    if (pendingIssues?.value) pendingIssues.value.length = 0;
    closeSheet?.();
  });

  async function mockSearchForAddress(address: string, items: any[]) {
    const { computeReporterHash, buildReporterMarker } = await import(
      '@/shared/lib/bug-report'
    );
    const marker = buildReporterMarker(await computeReporterHash(address));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            items: items.map((it) => ({ body: `${marker}\nx`, ...it })),
          }),
      }),
    );
  }

  it('checkStatuses filters out already-acknowledged issues', async () => {
    const { checkStatuses, pendingIssues, confirmResolved } =
      useBugReportStatus();
    await mockSearchForAddress('addr-1', [
      { number: 1, title: 'a', html_url: 'u1', state: 'closed' },
      { number: 2, title: 'b', html_url: 'u2', state: 'closed' },
    ]);
    confirmResolved('addr-1', 1); // pre-ack issue #1
    await checkStatuses('addr-1');
    expect(pendingIssues.value.map((i) => i.number)).toEqual([2]);
  });

  it('confirmResolved persists ack and drops from pending', async () => {
    const { checkStatuses, pendingIssues, confirmResolved } =
      useBugReportStatus();
    await mockSearchForAddress('addr-xyz', [
      { number: 5, title: 'x', html_url: 'u', state: 'closed' },
    ]);
    await checkStatuses('addr-xyz');
    expect(pendingIssues.value).toHaveLength(1);
    confirmResolved('addr-xyz', 5);
    expect(pendingIssues.value).toHaveLength(0);
  });

  it('markUnresolved reopens on GitHub, returns true, does NOT ack', async () => {
    const { checkStatuses, markUnresolved, pendingIssues } =
      useBugReportStatus();

    // Seed pending
    await mockSearchForAddress('addr-reopen', [
      { number: 9, title: 'y', html_url: 'u9', state: 'closed' },
    ]);
    await checkStatuses('addr-reopen');
    expect(pendingIssues.value).toHaveLength(1);

    // Now mock reopen calls
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fetchMock);

    const ok = await markUnresolved('addr-reopen', 9, 'still crashes');
    expect(ok).toBe(true);

    // And crucially: acknowledgeIssue was NOT called, so if the maintainer
    // closes it again, the user will see it again.
    const { getAcknowledgedNumbers } = await import(
      '@/shared/lib/bug-report'
    );
    expect(getAcknowledgedNumbers('addr-reopen')).toEqual([]);

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
    expect(pendingIssues.value).toHaveLength(0);
  });

  it('markUnresolved returns false and keeps issue in list when PATCH fails', async () => {
    const { checkStatuses, markUnresolved, pendingIssues } =
      useBugReportStatus();

    await mockSearchForAddress('addr-fail', [
      { number: 7, title: 'z', html_url: 'u7', state: 'closed' },
    ]);
    await checkStatuses('addr-fail');

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 403 })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) }),
    );

    const ok = await markUnresolved('addr-fail', 7, 'noop');
    expect(ok).toBe(false);
    // Still in the list so the UI can retry / show error
    expect(pendingIssues.value.map((i) => i.number)).toEqual([7]);
  });

  it('resetState clears pending, loading and sheetOpen', async () => {
    const { checkStatuses, pendingIssues, openSheet, sheetOpen, resetState } =
      useBugReportStatus();
    await mockSearchForAddress('addr-r', [
      { number: 1, title: 't', html_url: 'u', state: 'closed' },
    ]);
    await checkStatuses('addr-r');
    openSheet();
    expect(pendingIssues.value).toHaveLength(1);
    expect(sheetOpen.value).toBe(true);
    resetState();
    expect(pendingIssues.value).toHaveLength(0);
    expect(sheetOpen.value).toBe(false);
  });
});
