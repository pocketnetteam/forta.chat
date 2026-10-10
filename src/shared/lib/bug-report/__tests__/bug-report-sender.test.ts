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

  // Missed push calls T2: the invite history says whether FCM downgraded the
  // push and why no ringer came up, so "the push came, the ringer did not"
  // reads off a report.
  it('renders the FCM priority and the outcome of each invite push', async () => {
    const fetchMock = mockIssueCreate(14);
    vi.stubGlobal('fetch', fetchMock);

    await sendBugReport({
      description: 'did not ring',
      environment: fakeEnv,
      callDiagnostics: {
        audioMode: 'MODE_NORMAL',
        isSpeakerOn: false,
        isBtScoOn: false,
        inviteHistory: [
          { receivedAtMs: 2_000, sentAtMs: 1_000, deliveryLatencyMs: 1_000, expired: false, callId: 'call-rang-123456', priority: 1, originalPriority: 1, sentTimeSource: 'fcm', outcome: 'rang' },
          { receivedAtMs: 90_000, sentAtMs: 1_000, deliveryLatencyMs: 89_000, expired: true, callId: 'call-stale-1234', priority: 2, originalPriority: 1, sentTimeSource: 'fcm', outcome: 'stale' },
          { receivedAtMs: 3_000, sentAtMs: 0, deliveryLatencyMs: 3_000, expired: false, callId: '', priority: 0, originalPriority: 0, sentTimeSource: 'missing', outcome: 'incoming-calls-off' },
          { receivedAtMs: 4_000, sentAtMs: 3_500, deliveryLatencyMs: 500, expired: false, callId: 'call-old-format' },
        ],
        expiredInviteCount: 1,
        webrtcEngine: 'native',
        audioTimeline: [],
        ice: null,
        tor: null,
        fullScreenIntentAllowed: null,
      },
    });

    const body = JSON.parse(fetchMock.mock.calls.at(-1)![1].body as string).body as string;
    expect(body).toContain('| # | callId | latency (ms) | expired | FCM priority | outcome |');
    expect(body).toContain('| 1 | `call-rang-12` | 1000 | no | high | rang |');
    expect(body).toContain('| 2 | `call-stale-1` | 89000 | yes | normal (sent high) | stale |');
    expect(body).toContain('| 3 | `(none)` | no send time | no | unknown | incoming-calls-off |');
    expect(body).toContain('| 4 | `call-old-for` | 500 | no | ? | ? |');
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
