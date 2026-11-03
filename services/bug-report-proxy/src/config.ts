/** Settings of the bug-report proxy, read from the environment of the host. */
export interface ProxyConfig {
  /** Fine-grained token with Issues and Contents write access to one repository. */
  githubToken: string;
  /** Repository that receives the reports, as `owner/name`. */
  githubRepo: string;
  /** Key for the manage keys and the reporter markers; at least 32 characters. */
  proxySecret: string;
  /** Return issue links to the app. Turn on only for a public repository. */
  publicIssueLinks: boolean;
}

export type ProxyEnv = Record<string, string | undefined>;

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
export const MIN_SECRET_LENGTH = 32;

/** Throws when a setting is missing, so a misconfigured proxy never starts. */
export function configFromEnv(env: ProxyEnv): ProxyConfig {
  const githubToken = env.GITHUB_TOKEN?.trim() ?? '';
  const githubRepo = env.GITHUB_REPO?.trim() ?? '';
  const proxySecret = env.PROXY_SECRET?.trim() ?? '';
  if (!githubToken) throw new Error('GITHUB_TOKEN is not set');
  if (!REPO_RE.test(githubRepo)) throw new Error('GITHUB_REPO must be owner/name');
  if (proxySecret.length < MIN_SECRET_LENGTH) {
    throw new Error(`PROXY_SECRET must have at least ${MIN_SECRET_LENGTH} characters`);
  }
  return {
    githubToken,
    githubRepo,
    proxySecret,
    publicIssueLinks: env.PUBLIC_ISSUE_LINKS?.trim() === 'true',
  };
}
