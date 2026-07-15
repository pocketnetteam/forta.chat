import { describe, it, expect, vi } from 'vitest';
import {
  TRANSPORT_WHITELIST,
  buildTorProxyUrl,
  isWhitelistedHost,
  isWhitelistedUrl,
  shouldRouteThroughTor,
  TOR_HTTP_PROXY_PORT,
} from './routing';

describe('tor routing whitelist', () => {
  it('exports whitelist patterns for known CDN hosts', () => {
    expect(TRANSPORT_WHITELIST.length).toBeGreaterThanOrEqual(5);
  });

  it('isWhitelistedHost returns true for YouTube', () => {
    expect(isWhitelistedHost('www.youtube.com')).toBe(true);
    expect(isWhitelistedHost('youtube.com')).toBe(true);
  });

  it('isWhitelistedHost returns true for imgur and jsdelivr', () => {
    expect(isWhitelistedHost('i.imgur.com')).toBe(true);
    expect(isWhitelistedHost('cdn.jsdelivr.net')).toBe(true);
  });

  it('isWhitelistedHost returns true for brighteon photos', () => {
    expect(isWhitelistedHost('photos.brighteon.com')).toBe(true);
  });

  it('isWhitelistedHost returns false for PocketNet API hosts', () => {
    expect(isWhitelistedHost('api.bastyon.com')).toBe(false);
    expect(isWhitelistedHost('1.pocketnet.app')).toBe(false);
  });

  it('isWhitelistedHost returns false for unrelated hostnames', () => {
    expect(isWhitelistedHost('matrix.org')).toBe(false);
  });

  it('isWhitelistedUrl parses full URLs', () => {
    expect(isWhitelistedUrl('https://www.youtube.com/watch?v=abc')).toBe(true);
    expect(isWhitelistedUrl('https://api.bastyon.com/sdk/node/transactions')).toBe(false);
  });

  it('isWhitelistedUrl returns false for invalid URLs', () => {
    expect(isWhitelistedUrl('not-a-url')).toBe(false);
  });
});

describe('buildTorProxyUrl', () => {
  it('encodes original URL as proxy path segment', () => {
    const url = 'https://api.bastyon.com/sdk/node/transactions?limit=10';
    const proxyUrl = buildTorProxyUrl(url);

    expect(proxyUrl).toBe(
      `http://127.0.0.1:${TOR_HTTP_PROXY_PORT}/${encodeURIComponent(url)}`,
    );
    expect(decodeURIComponent(proxyUrl.split('/').pop()!)).toBe(url);
  });

  it('supports custom proxy port', () => {
    const url = 'https://example.com/path';
    expect(buildTorProxyUrl(url, 9191)).toContain('127.0.0.1:9191');
  });
});

describe('shouldRouteThroughTor', () => {
  it('returns false for whitelisted URLs without calling platform logic', async () => {
    const resolve = vi.fn().mockResolvedValue(true);

    const result = await shouldRouteThroughTor('https://www.youtube.com/embed/abc', resolve);

    expect(result).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('delegates non-whitelisted URLs to platform logic', async () => {
    const resolve = vi.fn().mockResolvedValue(true);
    const url = 'https://api.bastyon.com/sdk/node/transactions';

    const result = await shouldRouteThroughTor(url, resolve);

    expect(result).toBe(true);
    expect(resolve).toHaveBeenCalledWith(url);
  });

  it('returns false when platform logic rejects Tor', async () => {
    const resolve = vi.fn().mockResolvedValue(false);

    const result = await shouldRouteThroughTor('https://1.pocketnet.app/api', resolve);

    expect(result).toBe(false);
  });
});
