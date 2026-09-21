import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendBugReport, formatSyncDiagnostics, formatAge } from '../bug-report-sender';
import { computeReporterHash } from '../reporter-hash';
import type { AppEnvironment, BugReportSyncDiagnostics } from '../types';

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

const deadSync: BugReportSyncDiagnostics = {
  host: 'matrix.2.pocketnet.app',
  hasSyncToken: true,
  chatsReady: true,
  roomCount: 12,
  online: true,
  lastState: 'ERROR',
  lastStateAgeMs: 4_000,
  lastHealthyAgeMs: 3_725_000,
  healthyCount: 1,
  errorsSinceHealthy: 37,
  lastError: 'ConnectionError fetch failed | (cause: Failed to fetch)',
  lastErrorAgeMs: 4_000,
  unexpectedErrorCount: 0,
  lastUnexpectedError: null,
  lastUnexpectedErrorAgeMs: null,
  timelineEventCount: 0,
  lastTimelineEventAgeMs: null,
  listenerErrorCount: 0,
  lastListenerError: null,
  hostSwitches: [
    { from: 'matrix.pocketnet.app', to: 'matrix.2.pocketnet.app', reason: 'watchdog failover', ageMs: 600_000 },
  ],
};

describe('sendBugReport — sync diagnostics', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_BUG_REPORT_TOKEN', 'test-token');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function sentBody(syncDiagnostics?: BugReportSyncDiagnostics): Promise<string> {
    const fetchMock = mockIssueCreate();
    vi.stubGlobal('fetch', fetchMock);
    await sendBugReport({ description: 'no messages', environment: fakeEnv, syncDiagnostics });
    return JSON.parse(fetchMock.mock.calls.at(-1)![1].body as string).body as string;
  }

  it('renders the /sync health section when diagnostics are present', async () => {
    const body = await sentBody(deadSync);

    expect(body).toContain('## Sync diagnostics');
    expect(body).toContain('| Host | matrix.2.pocketnet.app |');
    expect(body).toContain('| Last healthy sync | 1h 2m ago (1 total) |');
    expect(body).toContain('| Errors since healthy | 37 |');
    expect(body).toContain('| Dropped batches (SDK) | 0 |');
    expect(body).toContain('| Live timeline events | 0 (last never) |');
    expect(body).toContain('| matrix.pocketnet.app | matrix.2.pocketnet.app | watchdog failover | 10m 0s ago |');
  });

  it('escapes pipes in error text so the markdown table stays intact', async () => {
    const body = await sentBody(deadSync);
    expect(body).toContain('| Last error | ConnectionError fetch failed \\| (cause: Failed to fetch) (4s ago) |');
  });

  it('omits the section when no diagnostics were collected (e.g. login screen)', async () => {
    const body = await sentBody(undefined);
    expect(body).not.toContain('## Sync diagnostics');
  });

  it('omits host-switch details when there were none', () => {
    const lines = formatSyncDiagnostics({ ...deadSync, hostSwitches: [] });
    expect(lines.join('\n')).not.toContain('Host switches');
  });
});

describe('formatAge', () => {
  it.each([
    [null, 'never'],
    [0, '0s ago'],
    [59_400, '59s ago'],
    [61_000, '1m 1s ago'],
    [3_600_000, '1h 0m ago'],
    [-5_000, '0s ago'],
  ])('%s → %s', (ms, expected) => {
    expect(formatAge(ms)).toBe(expected);
  });
});
