import { describe, it, expect } from 'vitest';
import { configFromEnv } from './config.ts';
import { FixedWindowLimiter } from './rate-limit.ts';
import { safeEqual } from './crypto.ts';

const env = { GITHUB_TOKEN: 't', GITHUB_REPO: 'owner/bugs', PROXY_SECRET: 'x'.repeat(32) };

describe('configFromEnv', () => {
  it('reads the settings; issue links stay off unless asked for', () => {
    expect(configFromEnv(env)).toEqual({
      githubToken: 't',
      githubRepo: 'owner/bugs',
      proxySecret: 'x'.repeat(32),
      publicIssueLinks: false,
    });
    expect(configFromEnv({ ...env, PUBLIC_ISSUE_LINKS: 'true' }).publicIssueLinks).toBe(true);
  });

  it.each([
    ['no token', { ...env, GITHUB_TOKEN: '' }],
    ['a repository without an owner', { ...env, GITHUB_REPO: 'bugs' }],
    ['a short secret', { ...env, PROXY_SECRET: 'short' }],
  ])('refuses to start with %s', (_name, broken) => {
    expect(() => configFromEnv(broken)).toThrow();
  });
});

describe('FixedWindowLimiter', () => {
  it('counts per key and resets after the window', () => {
    let t = 0;
    const limiter = new FixedWindowLimiter(2, 1000, () => t);
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('a')).toBe(false);
    expect(limiter.take('b')).toBe(true);
    expect(limiter.retryAfterSeconds('a')).toBe(1);
    t = 1000;
    expect(limiter.take('a')).toBe(true);
  });
});

describe('safeEqual', () => {
  it('matches equal strings only', () => {
    expect(safeEqual('abcd', 'abcd')).toBe(true);
    expect(safeEqual('abcd', 'abce')).toBe(false);
    expect(safeEqual('abcd', 'abc')).toBe(false);
  });
});
