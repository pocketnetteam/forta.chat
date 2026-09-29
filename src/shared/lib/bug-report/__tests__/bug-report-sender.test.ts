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

describe('sendBugReport — ICE and Tor rows (O05/O14)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_BUG_REPORT_TOKEN', 'test-token');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('renders the relay counts, the selected pair and the Tor state', async () => {
    const fetchMock = mockIssueCreate(11);
    vi.stubGlobal('fetch', fetchMock);

    await sendBugReport({
      description: 'no audio',
      environment: fakeEnv,
      callDiagnostics: {
        audioMode: 'MODE_IN_COMMUNICATION',
        isSpeakerOn: false,
        isBtScoOn: false,
        inviteHistory: [],
        expiredInviteCount: 0,
        webrtcEngine: 'native',
        audioTimeline: [],
        ice: { total: 3, relay: 0, host: 2, srflx: 1, selectedPairType: null, lastIceState: 'failed', turnServers: 0 },
        tor: { enabled: true, connected: true },
        fullScreenIntentAllowed: false,
      },
    });

    const body = JSON.parse(fetchMock.mock.calls.at(-1)![1].body as string).body as string;
    expect(body).toContain('| ICE candidates | relay=0 host=2 srflx=1 (TURN servers: 0) |');
    expect(body).toContain('| ICE result | failed via no pair |');
    expect(body).toContain('| Tor during calls | on — calls bypass Tor |');
    expect(body).toContain('| Full-screen intent | REVOKED |');
  });

  it('renders the encryption diagnostics, and nothing when there are none', async () => {
    const fetchMock = mockIssueCreate(13);
    vi.stubGlobal('fetch', fetchMock);

    await sendBugReport({
      description: 'сообщения приходят зашифрованными',
      environment: fakeEnv,
      screenshots: [],
      encryptionDiagnostics: {
        queue: { dead: 4, waiting: 1 },
        roomsAffected: 2,
        oldestHours: 30,
        topErrors: [{ error: 'No common key event found for hash=<hex>', count: 4 }],
      },
    });
    const withDiag = JSON.parse(fetchMock.mock.calls.at(-1)![1].body as string).body as string;
    expect(withDiag).toContain('## Encryption diagnostics');
    expect(withDiag).toContain('| Undecrypted messages | dead=4 waiting=1 |');
    expect(withDiag).toContain('| Error ×4 | No common key event found for hash=<hex> |');

    await sendBugReport({ description: 'other', environment: fakeEnv, screenshots: [] });
    const without = JSON.parse(fetchMock.mock.calls.at(-1)![1].body as string).body as string;
    expect(without).not.toContain('Encryption diagnostics');
  });

  it('omits the rows when the facts are unknown', async () => {
    const fetchMock = mockIssueCreate(12);
    vi.stubGlobal('fetch', fetchMock);

    await sendBugReport({
      description: 'no audio',
      environment: fakeEnv,
      callDiagnostics: {
        audioMode: 'MODE_NORMAL',
        isSpeakerOn: false,
        isBtScoOn: false,
        inviteHistory: [],
        expiredInviteCount: 0,
        webrtcEngine: 'native',
        audioTimeline: [],
        ice: null,
        tor: null,
        fullScreenIntentAllowed: null,
      },
    });

    const body = JSON.parse(fetchMock.mock.calls.at(-1)![1].body as string).body as string;
    expect(body).not.toContain('| ICE candidates |');
    expect(body).not.toContain('| Tor during calls |');
    expect(body).not.toContain('| Full-screen intent |');
  });
});
