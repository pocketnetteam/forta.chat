/**
 * The bug-report proxy (`services/bug-report-proxy`) holds the GitHub token
 * (audit S10-06). The app used to carry a token with write access in its
 * bundle and call the GitHub API itself.
 */
function getEndpoint(): string {
  const endpoint = import.meta.env.VITE_BUG_REPORT_ENDPOINT;
  if (!endpoint) throw new Error('Bug report endpoint not configured');
  return endpoint.replace(/\/+$/, '');
}

export function postToBugReportProxy(path: string, payload: unknown): Promise<Response> {
  return fetch(`${getEndpoint()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}
