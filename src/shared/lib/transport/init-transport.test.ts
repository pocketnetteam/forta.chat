import { describe, it, expect } from 'vitest';
import { isWhitelistedHost, TRANSPORT_WHITELIST } from '@/shared/lib/tor/routing';

describe('init-transport re-exports', () => {
  it('re-exports routing whitelist from init-transport', async () => {
    const initTransport = await import('./init-transport');
    expect(initTransport.TRANSPORT_WHITELIST).toBe(TRANSPORT_WHITELIST);
    expect(initTransport.isWhitelistedHost('www.youtube.com')).toBe(true);
  });
});

describe('init-transport whitelist compatibility', () => {
  it('isWhitelistedHost returns false for PocketNet API hosts', () => {
    expect(isWhitelistedHost('api.bastyon.com')).toBe(false);
    expect(isWhitelistedHost('1.pocketnet.app')).toBe(false);
  });
});
