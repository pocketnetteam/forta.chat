import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendBugReport } from '../bug-report-sender';
import { computeReporterHash } from '../reporter-hash';
import type { AppEnvironment } from '../types';

const fakeEnv: AppEnvironment = {
  platform: 'web',
  appVersion: '1.0.0',
  buildNumber: '1',
  webViewVersion: '',
  osVersion: '',
  deviceModel: '',
  screen: '1x1',
  locale: 'en',
  networkType: '',
  torStatus: '',
  matrixReady: false,
  currentRoute: '/',
  uptime: '0s',
  memoryMb: '0',
  userAgent: 'test',
};

function mockIssueCreate(number = 1) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () =>
      Promise.resolve({
        html_url: `https://github.com/x/y/issues/${number}`,
        number,
      }),
  });
}

describe('sendBugReport', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_BUG_REPORT_TOKEN', 'test-token');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('includes reporter marker when reporterAddress provided', async () => {
    const hash = await computeReporterHash('addr-1');
    const fetchMock = mockIssueCreate(10);
    vi.stubGlobal('fetch', fetchMock);

    await sendBugReport({
      description: 'hello',
      environment: fakeEnv,
      reporterAddress: 'addr-1',
    });

    const lastCall = fetchMock.mock.calls.at(-1)!;
    const body = JSON.parse(lastCall[1].body as string);
    expect(body.body).toContain(`<!-- reporter:${hash} -->`);
  });

  it('omits marker when no address provided', async () => {
    const fetchMock = mockIssueCreate();
    vi.stubGlobal('fetch', fetchMock);

    await sendBugReport({ description: 'hi', environment: fakeEnv });

    const lastCall = fetchMock.mock.calls.at(-1)!;
    const body = JSON.parse(lastCall[1].body as string);
    expect(body.body).not.toContain('<!-- reporter:');
  });

  it('returns issueNumber in result', async () => {
    const fetchMock = mockIssueCreate(42);
    vi.stubGlobal('fetch', fetchMock);

    const res = await sendBugReport({ description: 'hi', environment: fakeEnv });

    expect(res.issueNumber).toBe(42);
    expect(res.issueUrl).toBe('https://github.com/x/y/issues/42');
  });

  it('still creates issue when screenshots array is empty', async () => {
    const fetchMock = mockIssueCreate(3);
    vi.stubGlobal('fetch', fetchMock);

    await sendBugReport({
      description: 'hi',
      environment: fakeEnv,
      screenshots: [],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/issues');
  });

  it('throws when issue POST fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, text: () => '' }),
    );

    await expect(
      sendBugReport({ description: 'hi', environment: fakeEnv }),
    ).rejects.toThrow(/Failed to create issue/);
  });
});
