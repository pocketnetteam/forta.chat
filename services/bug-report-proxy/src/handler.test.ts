import { describe, it, expect, vi } from 'vitest';
import { createHandler, MAX_REQUEST_BYTES } from './handler.ts';
import { manageKeyFor, reporterMarkerFor } from './crypto.ts';
import type { ProxyConfig } from './config.ts';

const config: ProxyConfig = {
  githubToken: 'gh-token',
  githubRepo: 'owner/bugs',
  proxySecret: 's'.repeat(40),
  publicIssueLinks: false,
};

// 1×1 images: the first bytes are what the proxy checks.
const JPEG = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46));
const PNG = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0));
const GIF = btoa('GIF89a....');

interface GitHubCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
}

function fakeGitHub(overrides: { issueStatus?: number; putStatus?: number; patchStatus?: number } = {}) {
  const calls: GitHubCall[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const call: GitHubCall = {
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers as Record<string, string>,
      payload: JSON.parse(String(init?.body ?? '{}')),
    };
    calls.push(call);
    if (call.method === 'PUT') {
      const status = overrides.putStatus ?? 201;
      const path = url.split('/contents/')[1];
      return new Response(JSON.stringify({ content: { html_url: `https://github.com/owner/bugs/blob/main/${path}` } }), { status });
    }
    if (call.method === 'POST' && url.endsWith('/issues')) {
      const status = overrides.issueStatus ?? 201;
      return new Response(JSON.stringify({ number: 77, html_url: 'https://github.com/owner/bugs/issues/77' }), { status });
    }
    if (call.method === 'PATCH') return new Response('{}', { status: overrides.patchStatus ?? 200 });
    return new Response('{}', { status: 201 });
  });
  return { fetch, calls };
}

function post(path: string, payload: unknown): Request {
  return new Request(`https://proxy.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

describe('bug-report proxy — creating a report', () => {
  it('creates the issue with the token the app never sees', async () => {
    const gh = fakeGitHub();
    const handle = createHandler(config, { fetch: gh.fetch });

    const res = await handle(post('/v1/reports', { title: '[web] broken', body: '## Description\nbroken' }), '1.1.1.1');

    expect(res.status).toBe(201);
    const issueCall = gh.calls.find((c) => c.url.endsWith('/repos/owner/bugs/issues'))!;
    expect(issueCall.headers.Authorization).toBe('Bearer gh-token');
    expect(issueCall.headers['User-Agent']).toBeTruthy();
    expect(issueCall.payload).toMatchObject({ title: '[web] broken', labels: ['bug-report'] });
    const data = await res.json();
    expect(data).toMatchObject({ number: 77, url: null, screenshotsFailed: 0 });
    expect(data.manageKey).toBe(await manageKeyFor(config.proxySecret, 'owner/bugs', 77));
  });

  it('returns the issue link only for a repository set as public', async () => {
    const handle = createHandler({ ...config, publicIssueLinks: true }, { fetch: fakeGitHub().fetch });
    const res = await handle(post('/v1/reports', { title: 't', body: 'b' }), '1.1.1.1');
    expect((await res.json()).url).toBe('https://github.com/owner/bugs/issues/77');
  });

  it('writes a keyed reporter marker, not the hash anyone can compute from an address', async () => {
    const gh = fakeGitHub();
    const handle = createHandler(config, { fetch: gh.fetch });
    const reporter = '0123456789abcdef';

    await handle(post('/v1/reports', { title: 't', body: 'b', reporter }), '1.1.1.1');

    const body = gh.calls.at(-1)!.payload.body as string;
    expect(body).toContain(`<!-- reporter:${await reporterMarkerFor(config.proxySecret, reporter)} -->`);
    expect(body).not.toContain(reporter);
  });

  it('drops a marker and @mentions written into the report text', async () => {
    const gh = fakeGitHub();
    const handle = createHandler(config, { fetch: gh.fetch });

    await handle(post('/v1/reports', { title: 'ping @octocat', body: '<!-- reporter:aaaaaaaaaaaaaaaa --> hi @octocat' }), '1.1.1.1');

    const { title, body } = gh.calls.at(-1)!.payload as { title: string; body: string };
    expect(body).not.toContain('reporter:aaaa');
    expect(body).not.toMatch(/@octocat/);
    expect(title).not.toMatch(/@octocat/);
  });

  it('stores JPEG and PNG screenshots one after another and links them', async () => {
    const gh = fakeGitHub();
    const handle = createHandler(config, { fetch: gh.fetch, now: () => 1_700_000_000_000 });

    const res = await handle(post('/v1/reports', { title: 't', body: 'b', screenshots: [JPEG, PNG] }), '1.1.1.1');

    const puts = gh.calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(puts[0].url).toMatch(/\/contents\/bug-screenshots\/1700000000000-[0-9a-f]{8}-0\.jpg$/);
    expect(puts[1].url).toMatch(/-1\.png$/);
    expect(puts[0].payload.content).toBe(JPEG);
    const body = gh.calls.at(-1)!.payload.body as string;
    expect(body).toMatch(/!\[screenshot 1\]\(https:\/\/github\.com\/owner\/bugs\/blob\/main\/bug-screenshots\/[^)]+\.jpg\?raw=true\)/);
    expect((await res.json()).screenshotsFailed).toBe(0);
  });

  it('still creates the issue when a screenshot cannot be stored', async () => {
    const gh = fakeGitHub({ putStatus: 409 });
    const handle = createHandler(config, { fetch: gh.fetch });

    const res = await handle(post('/v1/reports', { title: 't', body: 'b', screenshots: [JPEG] }), '1.1.1.1');

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ screenshotsFailed: 1, uploadError: 'GitHub 409' });
    expect(gh.calls.at(-1)!.payload.body).toContain('could not be stored');
  });

  it.each([
    ['no title', { body: 'b' }],
    ['a title too long', { title: 'x'.repeat(257), body: 'b' }],
    ['a body too long', { title: 't', body: 'x'.repeat(60_001) }],
    ['a malformed reporter', { title: 't', body: 'b', reporter: 'not-hex' }],
    ['a GIF screenshot', { title: 't', body: 'b', screenshots: [GIF] }],
    ['six screenshots', { title: 't', body: 'b', screenshots: Array(6).fill(JPEG) }],
    ['a screenshot that is not base64', { title: 't', body: 'b', screenshots: ['<svg>'] }],
  ])('refuses a report with %s and calls no GitHub API', async (_name, payload) => {
    const gh = fakeGitHub();
    const handle = createHandler(config, { fetch: gh.fetch });

    const res = await handle(post('/v1/reports', payload), '1.1.1.1');

    expect(res.status).toBe(400);
    expect(gh.fetch).not.toHaveBeenCalled();
  });

  it('cuts a body that sanitizing grew past the GitHub limit', async () => {
    const gh = fakeGitHub();
    const handle = createHandler(config, { fetch: gh.fetch });

    const res = await handle(post('/v1/reports', { title: 't', body: ' @a'.repeat(20_000), reporter: '0123456789abcdef' }), '1.1.1.1');

    expect(res.status).toBe(201);
    const body = gh.calls.at(-1)!.payload.body as string;
    expect(body.length).toBeLessThanOrEqual(65_536);
    expect(body).toMatch(/cut to fit GitHub/);
    expect(body).toMatch(/^<!-- reporter:/);
  });

  it('takes five screenshots at the 2 MB cap in one request', async () => {
    const gh = fakeGitHub();
    const handle = createHandler(config, { fetch: gh.fetch });
    const big = JPEG.slice(0, 12) + 'A'.repeat(2_796_000 - 12);

    const res = await handle(post('/v1/reports', { title: 't', body: 'b', screenshots: Array(5).fill(big) }), '1.1.1.1');

    expect(res.status).toBe(201);
    expect(gh.calls.filter((c) => c.method === 'PUT')).toHaveLength(5);
  });

  it('refuses a request declared larger than the cap before reading it', async () => {
    const handle = createHandler(config, { fetch: fakeGitHub().fetch });
    const request = new Request('https://proxy.test/v1/reports', {
      method: 'POST',
      headers: { 'Content-Length': String(MAX_REQUEST_BYTES + 1) },
      body: '{}',
    });
    expect((await handle(request, '1.1.1.1')).status).toBe(413);
  });

  it('answers 502 when GitHub refuses the issue', async () => {
    const handle = createHandler(config, { fetch: fakeGitHub({ issueStatus: 401 }).fetch });
    const res = await handle(post('/v1/reports', { title: 't', body: 'b' }), '1.1.1.1');
    expect(res.status).toBe(502);
  });

  it('limits reports per address and lets the next window through', async () => {
    let t = 0;
    const handle = createHandler(config, { fetch: fakeGitHub().fetch, now: () => t });
    for (let i = 0; i < 10; i++) {
      expect((await handle(post('/v1/reports', { title: 't', body: 'b' }), '2.2.2.2')).status).toBe(201);
    }
    const limited = await handle(post('/v1/reports', { title: 't', body: 'b' }), '2.2.2.2');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect((await handle(post('/v1/reports', { title: 't', body: 'b' }), '3.3.3.3')).status).toBe(201);
    t += 10 * 60_000;
    expect((await handle(post('/v1/reports', { title: 't', body: 'b' }), '2.2.2.2')).status).toBe(201);
  });
});

describe('bug-report proxy — closing and reopening', () => {
  it('changes the state and adds the note when the manage key matches', async () => {
    const gh = fakeGitHub();
    const handle = createHandler(config, { fetch: gh.fetch });
    const manageKey = await manageKeyFor(config.proxySecret, 'owner/bugs', 12);

    const res = await handle(post('/v1/reports/12/state', { state: 'open', comment: 'still broken', manageKey }), '1.1.1.1');

    expect(res.status).toBe(200);
    expect(gh.calls[0]).toMatchObject({ method: 'PATCH', payload: { state: 'open', state_reason: 'reopened' } });
    expect(gh.calls[0].url).toMatch(/\/repos\/owner\/bugs\/issues\/12$/);
    expect(gh.calls[1]).toMatchObject({ method: 'POST', payload: { body: 'still broken' } });
  });

  it('closes without a comment when there is no note', async () => {
    const gh = fakeGitHub();
    const handle = createHandler(config, { fetch: gh.fetch });
    const manageKey = await manageKeyFor(config.proxySecret, 'owner/bugs', 12);

    await handle(post('/v1/reports/12/state', { state: 'closed', manageKey }), '1.1.1.1');

    expect(gh.calls).toHaveLength(1);
    expect(gh.calls[0].payload).toEqual({ state: 'closed', state_reason: 'completed' });
  });

  it("refuses another issue's key", async () => {
    const gh = fakeGitHub();
    const handle = createHandler(config, { fetch: gh.fetch });
    const keyOf13 = await manageKeyFor(config.proxySecret, 'owner/bugs', 13);

    const res = await handle(post('/v1/reports/12/state', { state: 'closed', manageKey: keyOf13 }), '1.1.1.1');

    expect(res.status).toBe(403);
    expect(gh.fetch).not.toHaveBeenCalled();
  });

  it('refuses a request without a key', async () => {
    const handle = createHandler(config, { fetch: fakeGitHub().fetch });
    const res = await handle(post('/v1/reports/12/state', { state: 'closed' }), '1.1.1.1');
    expect(res.status).toBe(400);
  });

  it('answers 404 for an issue GitHub does not have', async () => {
    const handle = createHandler(config, { fetch: fakeGitHub({ patchStatus: 404 }).fetch });
    const manageKey = await manageKeyFor(config.proxySecret, 'owner/bugs', 12);
    const res = await handle(post('/v1/reports/12/state', { state: 'closed', manageKey }), '1.1.1.1');
    expect(res.status).toBe(404);
  });
});

describe('bug-report proxy — routing and CORS', () => {
  it('answers the preflight with CORS headers', async () => {
    const handle = createHandler(config, { fetch: fakeGitHub().fetch });
    const res = await handle(new Request('https://proxy.test/v1/reports', { method: 'OPTIONS' }), '1.1.1.1');
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Content-Type');
  });

  it('puts CORS headers on errors too, so the app can read them', async () => {
    const handle = createHandler(config, { fetch: fakeGitHub().fetch });
    const res = await handle(post('/v1/reports', 'nope'), '1.1.1.1');
    expect(res.status).toBe(400);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('serves nothing else', async () => {
    const gh = fakeGitHub();
    const handle = createHandler(config, { fetch: gh.fetch });
    expect((await handle(post('/v1/search', {}), '1.1.1.1')).status).toBe(404);
    expect((await handle(new Request('https://proxy.test/v1/reports'), '1.1.1.1')).status).toBe(405);
    expect(gh.fetch).not.toHaveBeenCalled();
  });
});
