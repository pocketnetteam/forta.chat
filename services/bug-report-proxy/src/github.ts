const API_BASE = 'https://api.github.com';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type GitHubResult<T> = ({ ok: true } & T) | { ok: false; status: number };

/** The few GitHub REST calls the proxy makes, for one repository. */
export class GitHubClient {
  private readonly token: string;
  private readonly repo: string;
  private readonly doFetch: FetchLike;

  constructor(token: string, repo: string, doFetch: FetchLike) {
    this.token = token;
    this.repo = repo;
    this.doFetch = doFetch;
  }

  /** Stores a file on the default branch; the link renders for viewers with access. */
  async putFile(path: string, base64: string, message: string): Promise<GitHubResult<{ htmlUrl: string }>> {
    const res = await this.call('PUT', `/contents/${path}`, { message, content: base64 });
    if (!res.ok) return res;
    const htmlUrl = (res.data.content as { html_url?: unknown } | undefined)?.html_url;
    if (typeof htmlUrl !== 'string') return { ok: false, status: 502 };
    return { ok: true, htmlUrl };
  }

  async createIssue(title: string, body: string, labels: string[]): Promise<GitHubResult<{ number: number; htmlUrl: string }>> {
    const res = await this.call('POST', '/issues', { title, body, labels });
    if (!res.ok) return res;
    const { number, html_url: htmlUrl } = res.data;
    if (typeof number !== 'number' || typeof htmlUrl !== 'string') return { ok: false, status: 502 };
    return { ok: true, number, htmlUrl };
  }

  async setIssueState(issueNumber: number, state: 'open' | 'closed'): Promise<GitHubResult<object>> {
    const stateReason = state === 'open' ? 'reopened' : 'completed';
    const res = await this.call('PATCH', `/issues/${issueNumber}`, { state, state_reason: stateReason });
    return res.ok ? { ok: true } : res;
  }

  async comment(issueNumber: number, body: string): Promise<GitHubResult<object>> {
    const res = await this.call('POST', `/issues/${issueNumber}/comments`, { body });
    return res.ok ? { ok: true } : res;
  }

  private async call(
    method: string,
    path: string,
    payload: unknown,
  ): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; status: number }> {
    try {
      const res = await this.doFetch(`${API_BASE}/repos/${this.repo}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
          // GitHub refuses a request without one, and Workers send none.
          'User-Agent': 'forta-bug-report-proxy',
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) return { ok: false, status: res.status };
      const data = (await res.json()) as unknown;
      return { ok: true, data: data && typeof data === 'object' ? (data as Record<string, unknown>) : {} };
    } catch {
      return { ok: false, status: 0 };
    }
  }
}
