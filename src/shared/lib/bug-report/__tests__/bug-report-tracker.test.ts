import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchUserClosedIssues,
  reopenIssue,
  getAcknowledgedNumbers,
  acknowledgeIssue,
  clearAcknowledged,
  hasAcknowledged,
} from '../bug-report-tracker';

beforeEach(() => {
  vi.stubEnv('VITE_BUG_REPORT_TOKEN', 'test-token');
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('fetchUserClosedIssues', () => {
  async function issueBody(address: string) {
    const { computeReporterHash, buildReporterMarker } = await import(
      '../reporter-hash'
    );
    const hash = await computeReporterHash(address);
    return { marker: buildReporterMarker(hash), hash };
  }

  it('queries GitHub search API with quoted marker + in:body + state:closed', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await fetchUserClosedIssues('addr-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/search/issues');
    expect(url).toContain(
      encodeURIComponent('repo:greenShirtMystery/forta-bugs'),
    );
    expect(url).toContain(encodeURIComponent('state:closed'));
    expect(url).toContain(encodeURIComponent('in:body'));
    // Quoted exact-phrase search
    expect(url).toMatch(/%22reporter%3A[0-9a-f]{16}%22/);
  });

  it('keeps only items whose body actually contains the marker', async () => {
    const { marker } = await issueBody('addr-1');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            items: [
              {
                number: 42,
                title: '[android] crash',
                html_url: 'https://github.com/x/y/issues/42',
                state: 'closed',
                closed_at: '2026-04-10T00:00:00Z',
                state_reason: 'completed',
                body: `${marker}\n\n## Description\nfoo`,
              },
              // Decoy without the marker — search could return it from a
              // different qualifier match; client-side filter MUST drop it.
              {
                number: 99,
                title: '[x] other user',
                html_url: 'https://github.com/x/y/issues/99',
                state: 'closed',
                body: 'No marker here.',
              },
            ],
          }),
      }),
    );

    const issues = await fetchUserClosedIssues('addr-1');
    expect(issues.map((i) => i.number)).toEqual([42]);
  });

  it('returns [] on HTTP error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 403 }),
    );
    expect(await fetchUserClosedIssues('addr-1')).toEqual([]);
  });

  it('returns [] when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    expect(await fetchUserClosedIssues('addr-1')).toEqual([]);
  });

  it('returns [] when address is empty', async () => {
    vi.stubGlobal('fetch', vi.fn());
    expect(await fetchUserClosedIssues('')).toEqual([]);
  });
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

describe('reopenIssue', () => {
  it('PATCHes issue with state=open, posts comment, returns true', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fetchMock);

    const ok = await reopenIssue(42, 'still broken after v1.2.3');

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [patchUrl, patchInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(patchUrl).toContain('/repos/greenShirtMystery/forta-bugs/issues/42');
    expect(patchInit.method).toBe('PATCH');
    expect(JSON.parse(patchInit.body as string)).toMatchObject({ state: 'open' });

    const [commentUrl, commentInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(commentUrl).toContain('/issues/42/comments');
    expect(commentInit.method).toBe('POST');
    const commentBody = JSON.parse(commentInit.body as string);
    expect(commentBody.body).toContain('still broken');
  });

  it('returns false when PATCH is not ok (still posts comment)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 403 })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fetchMock);

    const ok = await reopenIssue(1, 'x');
    expect(ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
