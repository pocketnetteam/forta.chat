// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  reopenIssue,
  closeIssue,
  trackCreatedIssue,
  getLocalIssueCache,
  getAcknowledgedNumbers,
  acknowledgeIssue,
  clearAcknowledged,
  hasAcknowledged,
} from '../bug-report-tracker';

beforeEach(() => {
  vi.stubEnv('VITE_BUG_REPORT_ENDPOINT', 'https://bugs.test/');
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('acknowledgements', () => {
  it('persists acknowledgements per-address', () => {
    acknowledgeIssue('addr-1', 1);
    acknowledgeIssue('addr-1', 2);
    acknowledgeIssue('addr-2', 3);
    expect(getAcknowledgedNumbers('addr-1').sort()).toEqual([1, 2]);
    expect(getAcknowledgedNumbers('addr-2')).toEqual([3]);
  });

  it('dedupes repeated acknowledgements', () => {
    acknowledgeIssue('a', 1);
    acknowledgeIssue('a', 1);
    expect(getAcknowledgedNumbers('a')).toEqual([1]);
  });

  it('hasAcknowledged reports membership', () => {
    acknowledgeIssue('a', 7);
    expect(hasAcknowledged('a', 7)).toBe(true);
    expect(hasAcknowledged('a', 8)).toBe(false);
  });

  it('clearAcknowledged removes a single entry', () => {
    acknowledgeIssue('a', 1);
    acknowledgeIssue('a', 2);
    clearAcknowledged('a', 1);
    expect(getAcknowledgedNumbers('a')).toEqual([2]);
  });

  it('returns [] for unknown address', () => {
    expect(getAcknowledgedNumbers('ghost')).toEqual([]);
  });

  it('tolerates corrupted storage', () => {
    localStorage.setItem('forta-chat:bug-report-ack:addr-1', 'not-json');
    expect(getAcknowledgedNumbers('addr-1')).toEqual([]);
  });
});

describe('reopenIssue / closeIssue', () => {
  const KEY = '0123456789abcdef0123456789abcdef';

  it('asks the proxy, never GitHub, and sends no token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const ok = await reopenIssue(42, 'still broken after v1.2.3', KEY);

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://bugs.test/v1/reports/42/state');
    expect(init.method).toBe('POST');
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization/i);
    expect(JSON.parse(init.body as string)).toEqual({
      state: 'open',
      comment: 'still broken after v1.2.3',
      manageKey: KEY,
    });
  });

  it('scrubs identifiers out of the note', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    await closeIssue(7, 'fixed for @abc123:matrix.pocketnet.app', KEY);

    const payload = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(payload).toMatchObject({ state: 'closed', comment: 'fixed for <user>' });
  });

  it('returns false when the proxy refuses or cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    expect(await reopenIssue(1, 'x', KEY)).toBe(false);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await closeIssue(1, 'x', KEY)).toBe(false);
  });

  it('returns false without an endpoint in the build', async () => {
    vi.stubEnv('VITE_BUG_REPORT_ENDPOINT', '');
    vi.stubGlobal('fetch', vi.fn());
    expect(await reopenIssue(1, 'x', KEY)).toBe(false);
  });
});

describe('trackCreatedIssue', () => {
  it('keeps the manage key and the link the proxy returned', () => {
    trackCreatedIssue('addr-1', { number: 5, title: 't', manageKey: 'k', url: null });
    expect(getLocalIssueCache('addr-1')[0]).toMatchObject({ number: 5, manageKey: 'k', url: '' });
  });
});
