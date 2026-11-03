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

const KEY = '0123456789abcdef0123456789abcdef';

function mockIssueCreate(number = 1, extra: Record<string, unknown> = {}) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 201,
    json: () =>
      Promise.resolve({
        number,
        url: `https://github.com/x/y/issues/${number}`,
        manageKey: KEY,
        screenshotsFailed: 0,
        ...extra,
      }),
  });
}

function sentPayload(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls.at(-1)![1].body as string);
}

describe('sendBugReport', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_BUG_REPORT_ENDPOINT', 'https://bugs.test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('posts to the proxy without any GitHub token (audit S10-06)', async () => {
    const fetchMock = mockIssueCreate(10);
    vi.stubGlobal('fetch', fetchMock);

    await sendBugReport({ description: 'hello', environment: fakeEnv });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://bugs.test/v1/reports');
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization|bearer/i);
    expect(sentPayload(fetchMock)).toMatchObject({ title: '[web] hello' });
  });

  it('sends the reporter hash for the proxy to key, not a marker in the body', async () => {
    const hash = await computeReporterHash('addr-1');
    const fetchMock = mockIssueCreate(10);
    vi.stubGlobal('fetch', fetchMock);

    await sendBugReport({ description: 'hello', environment: fakeEnv, reporterAddress: 'addr-1' });

    const payload = sentPayload(fetchMock);
    expect(payload.reporter).toBe(hash);
    expect(payload.body).not.toContain('reporter:');
  });

  it('sends no reporter when no address is provided', async () => {
    const fetchMock = mockIssueCreate();
    vi.stubGlobal('fetch', fetchMock);

    await sendBugReport({ description: 'hi', environment: fakeEnv });

    expect(sentPayload(fetchMock).reporter).toBeUndefined();
  });

  it('scrubs identifiers from the title and the body before they leave the device', async () => {
    const fetchMock = mockIssueCreate();
    vi.stubGlobal('fetch', fetchMock);

    await sendBugReport({
      description: 'call from @a1b2:matrix.pocketnet.app dropped',
      environment: { ...fakeEnv, currentRoute: '/chat?room=!Room1:matrix.pocketnet.app' },
    });

    const { title, body } = sentPayload(fetchMock) as { title: string; body: string };
    expect(title).toBe('[web] call from <user> dropped');
    expect(body).toContain('`/chat?room=<room>`');
    expect(body).not.toContain('matrix.pocketnet.app');
  });

  it('cuts a body the proxy would refuse', async () => {
    const fetchMock = mockIssueCreate();
    vi.stubGlobal('fetch', fetchMock);

    await sendBugReport({ description: 'x', environment: fakeEnv, aiDiagnostics: { logs: 'y'.repeat(70_000) } });

    const body = sentPayload(fetchMock).body as string;
    expect(body.length).toBeLessThanOrEqual(58_000);
    expect(body).toMatch(/cut on the device/);
  });

  it('returns the issue number, link and manage key', async () => {
    vi.stubGlobal('fetch', mockIssueCreate(42));

    const res = await sendBugReport({ description: 'hi', environment: fakeEnv });

    expect(res).toMatchObject({ issueNumber: 42, issueUrl: 'https://github.com/x/y/issues/42', manageKey: KEY });
  });

  it('returns a null link for a private repository', async () => {
    vi.stubGlobal('fetch', mockIssueCreate(42, { url: null }));
    expect((await sendBugReport({ description: 'hi', environment: fakeEnv })).issueUrl).toBeNull();
  });

  it('leaves out a screenshot the proxy would refuse and counts it as failed', async () => {
    const fetchMock = mockIssueCreate(3);
    vi.stubGlobal('fetch', fetchMock);

    // An image that does not decode goes out as given, as compressImage falls back.
    vi.stubGlobal('Image', class {
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    });
    const res = await sendBugReport({
      description: 'hi',
      environment: fakeEnv,
      screenshots: ['/9j/4AAQSkZJRg', 'AAAAHGZ0eXBoZWlj'],
    });

    expect(sentPayload(fetchMock).screenshots).toEqual(['/9j/4AAQSkZJRg']);
    expect(res).toMatchObject({ screenshotsFailed: 1, uploadError: 'unsupported image' });
  });

  it('throws without an endpoint in the build', async () => {
    vi.stubEnv('VITE_BUG_REPORT_ENDPOINT', '');
    vi.stubGlobal('fetch', vi.fn());
    await expect(sendBugReport({ description: 'hi', environment: fakeEnv })).rejects.toThrow(/not configured/);
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
    vi.stubEnv('VITE_BUG_REPORT_ENDPOINT', 'https://bugs.test');
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
        ringAudio: [],
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
        ringAudio: [],
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

  // "Rings very quietly": the ring log says which audio mode the ringtone
  // played in, whether a stranded VoIP mode was dropped, and whether Telecom
  // held the call (none = the ring ran without Telecom).
  it('renders the audio state of the last rings', async () => {
    const fetchMock = mockIssueCreate(15);
    vi.stubGlobal('fetch', fetchMock);

    await sendBugReport({
      description: 'звонит очень тихо',
      environment: fakeEnv,
      callDiagnostics: {
        audioMode: 'MODE_NORMAL',
        isSpeakerOn: false,
        isBtScoOn: false,
        inviteHistory: [],
        expiredInviteCount: 0,
        webrtcEngine: 'native',
        audioTimeline: [],
        ringAudio: [
          { atMs: Date.UTC(2026, 9, 15, 9, 41, 7), callId: 'call-quiet-123456', modeAtArm: 'MODE_IN_COMMUNICATION', modeReset: true, telecom: 'none', modeInRing: 'MODE_NORMAL' },
          { atMs: Date.UTC(2026, 9, 15, 9, 45, 0), callId: 'call-waiting-1', modeAtArm: 'MODE_IN_COMMUNICATION', modeReset: false, telecom: 'ACTIVE, another call', modeInRing: '' },
          { atMs: Number.NaN, callId: 'call-bad-time', modeAtArm: 'MODE_NORMAL', modeReset: false, telecom: 'none', modeInRing: 'MODE_NORMAL' },
        ],
        ice: null,
        tor: null,
        fullScreenIntentAllowed: null,
      },
    });

    const body = JSON.parse(fetchMock.mock.calls.at(-1)![1].body as string).body as string;
    expect(body).toContain('<details><summary>Incoming ring audio</summary>');
    expect(body).toContain('| # | time (UTC) | callId | mode at ring | stranded mode reset | mode in ring | Telecom |');
    expect(body).toContain('| 1 | 09:41:07 | `call-quiet-1` | MODE_IN_COMMUNICATION | yes | MODE_NORMAL | none |');
    expect(body).toContain('| 2 | 09:45:00 | `call-waiting` | MODE_IN_COMMUNICATION | no | — | ACTIVE, another call |');
    expect(body).toContain('| 3 | ? | `call-bad-tim` | MODE_NORMAL | no | MODE_NORMAL | none |');
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
        ringAudio: [],
        ice: null,
        tor: null,
        fullScreenIntentAllowed: null,
      },
    });

    const body = JSON.parse(fetchMock.mock.calls.at(-1)![1].body as string).body as string;
    expect(body).not.toContain('| ICE candidates |');
    expect(body).not.toContain('| Tor during calls |');
    expect(body).not.toContain('| Full-screen intent |');
    expect(body).not.toContain('Incoming ring audio');
  });
});
