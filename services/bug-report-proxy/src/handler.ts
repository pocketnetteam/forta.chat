import type { ProxyConfig } from './config.ts';
import { manageKeyFor, reporterMarkerFor, safeEqual } from './crypto.ts';
import { GitHubClient, type FetchLike } from './github.ts';
import { FixedWindowLimiter } from './rate-limit.ts';
import { parseReport, parseStateChange, sanitizeForGitHub, ValidationError } from './validate.ts';

/**
 * Bug-report proxy (audit S10-06). The app used to ship a GitHub token with
 * write access and call the GitHub API itself; anyone could take the token
 * from the bundle. The token now lives only here, and the app can do two
 * things: create a report, and close or reopen a report it created.
 *
 * POST /v1/reports              { title, body, reporter?, screenshots? }
 *   → 201 { number, url, manageKey, screenshotsFailed, uploadError? }
 * POST /v1/reports/{n}/state    { state, comment?, manageKey }
 *   → 200 { ok: true }
 */

/** Larger requests are refused before they are read: 5 screenshots of 2 MB in base64 and the text fit. */
export const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
/** GitHub refuses a longer issue body. */
const GITHUB_MAX_BODY = 65_536;
const CUT_NOTE = '\n\n_The report was cut to fit GitHub._';

const REPORTS_PER_IP = 10;
const REPORT_WINDOW_MS = 10 * 60_000;
const REPORTS_PER_HOUR_TOTAL = 300;
const STATE_CHANGES_PER_IP = 30;
const STATE_WINDOW_MS = 60 * 60_000;
const GLOBAL_KEY = '*';

const ISSUE_LABELS = ['bug-report'];
const STATE_PATH_RE = /^\/v1\/reports\/([1-9]\d{0,8})\/state$/;

const CORS_HEADERS: Record<string, string> = {
  // No cookies or credentials: any origin may call, as any client can.
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export type Handler = (request: Request, clientIp: string) => Promise<Response>;

export interface HandlerDeps {
  fetch?: FetchLike;
  now?: () => number;
}

function json(status: number, payload: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...extraHeaders },
  });
}

async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (declared > MAX_REQUEST_BYTES) throw new TooLargeError();
  const raw = await request.text();
  if (raw.length > MAX_REQUEST_BYTES) throw new TooLargeError();
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ValidationError('body is not JSON');
  }
}

class TooLargeError extends Error {}

function screenshotSection(links: string[], failures: number[]): string {
  if (links.length === 0 && failures.length === 0) return '';
  const lines = ['', '', '## Screenshots'];
  links.forEach((link, i) => lines.push(`![screenshot ${i + 1}](${link})`));
  if (failures.length > 0) lines.push('', `_${failures.length} screenshot(s) could not be stored (GitHub ${failures[0]})._`);
  return lines.join('\n');
}

function randomSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function createHandler(config: ProxyConfig, deps: HandlerDeps = {}): Handler {
  // A Worker throws "Illegal invocation" on fetch called as a method of another object.
  const doFetch: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? Date.now;
  const github = new GitHubClient(config.githubToken, config.githubRepo, doFetch);
  const reportsPerIp = new FixedWindowLimiter(REPORTS_PER_IP, REPORT_WINDOW_MS, now);
  const reportsTotal = new FixedWindowLimiter(REPORTS_PER_HOUR_TOTAL, STATE_WINDOW_MS, now);
  const stateChangesPerIp = new FixedWindowLimiter(STATE_CHANGES_PER_IP, STATE_WINDOW_MS, now);

  async function createReport(request: Request, clientIp: string): Promise<Response> {
    if (!reportsPerIp.take(clientIp)) {
      return json(429, { error: 'rate_limited' }, { 'Retry-After': String(reportsPerIp.retryAfterSeconds(clientIp)) });
    }
    if (!reportsTotal.take(GLOBAL_KEY)) {
      return json(429, { error: 'rate_limited' }, { 'Retry-After': String(reportsTotal.retryAfterSeconds(GLOBAL_KEY)) });
    }
    const report = parseReport(await readJson(request));

    // One after another: each Contents API PUT is a commit on the same
    // branch, and concurrent ones fail with 409.
    const links: string[] = [];
    const failures: number[] = [];
    const stamp = now();
    for (const [i, shot] of report.screenshots.entries()) {
      const name = `${stamp}-${randomSuffix()}-${i}.${shot.extension}`;
      const stored = await github.putFile(`bug-screenshots/${name}`, shot.base64, `bug-report: screenshot ${name}`);
      if (stored.ok) links.push(`${stored.htmlUrl}?raw=true`);
      else failures.push(stored.status);
    }

    const marker = report.reporter
      ? `<!-- reporter:${await reporterMarkerFor(config.proxySecret, report.reporter)} -->\n\n`
      : '';
    // Sanitizing adds a character per @, so a body near the cap can outgrow GitHub's.
    const section = screenshotSection(links, failures);
    const text = sanitizeForGitHub(report.body);
    const room = GITHUB_MAX_BODY - marker.length - section.length;
    const body = marker + (text.length > room ? text.slice(0, room - CUT_NOTE.length) + CUT_NOTE : text) + section;
    const issue = await github.createIssue(sanitizeForGitHub(report.title), body, ISSUE_LABELS);
    if (!issue.ok) {
      console.error(`[bug-report-proxy] create issue failed: GitHub ${issue.status}`);
      return json(502, { error: 'upstream', status: issue.status });
    }
    return json(201, {
      number: issue.number,
      url: config.publicIssueLinks ? issue.htmlUrl : null,
      manageKey: await manageKeyFor(config.proxySecret, config.githubRepo, issue.number),
      screenshotsFailed: failures.length,
      ...(failures.length > 0 ? { uploadError: `GitHub ${failures[0]}` } : {}),
    });
  }

  async function changeState(request: Request, clientIp: string, issueNumber: number): Promise<Response> {
    if (!stateChangesPerIp.take(clientIp)) {
      return json(429, { error: 'rate_limited' }, { 'Retry-After': String(stateChangesPerIp.retryAfterSeconds(clientIp)) });
    }
    const change = parseStateChange(await readJson(request));
    const expected = await manageKeyFor(config.proxySecret, config.githubRepo, issueNumber);
    if (!safeEqual(expected, change.manageKey)) return json(403, { error: 'forbidden' });

    const patched = await github.setIssueState(issueNumber, change.state);
    if (!patched.ok) {
      console.error(`[bug-report-proxy] state change of #${issueNumber} failed: GitHub ${patched.status}`);
      return json(patched.status === 404 ? 404 : 502, { error: patched.status === 404 ? 'not_found' : 'upstream' });
    }
    // The state is what the reporter asked for; the note is best effort.
    if (change.comment) {
      const commented = await github.comment(issueNumber, sanitizeForGitHub(change.comment));
      if (!commented.ok) console.error(`[bug-report-proxy] comment on #${issueNumber} failed: GitHub ${commented.status}`);
    }
    return json(200, { ok: true });
  }

  return async function handle(request, clientIp) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    const { pathname } = new URL(request.url);
    const stateMatch = STATE_PATH_RE.exec(pathname);
    if (pathname !== '/v1/reports' && !stateMatch) return json(404, { error: 'not_found' });
    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' }, { Allow: 'POST, OPTIONS' });
    try {
      return stateMatch
        ? await changeState(request, clientIp, Number(stateMatch[1]))
        : await createReport(request, clientIp);
    } catch (e) {
      if (e instanceof ValidationError) return json(400, { error: 'bad_request', message: e.message });
      if (e instanceof TooLargeError) return json(413, { error: 'too_large' });
      console.error('[bug-report-proxy] request failed:', e);
      return json(500, { error: 'internal' });
    }
  };
}
