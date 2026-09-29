import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('./init-transport', () => ({ resolveUsesTor: vi.fn() }));

import { routeUploadUrl } from './direct-upload';

const URL_ = 'https://matrix.example/_matrix/media/v3/upload';

function withController(controller: unknown) {
  vi.stubGlobal('navigator', { serviceWorker: { controller } });
}

describe('routeUploadUrl', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('flags a direct upload so the service worker lets it through', async () => {
    withController({});
    await expect(routeUploadUrl(URL_, async () => false)).resolves.toBe(`${URL_}?forta_direct=1`);
  });

  it('leaves an upload Tor claims to the worker', async () => {
    withController({});
    await expect(routeUploadUrl(URL_, async () => true)).resolves.toBe(URL_);
  });

  it('leaves the URL alone when the routing cannot answer', async () => {
    withController({});
    await expect(routeUploadUrl(URL_, async () => { throw new Error('no bridge'); })).resolves.toBe(URL_);
  });

  it('does not ask when no worker controls the page', async () => {
    withController(null);
    const usesTor = vi.fn();
    await expect(routeUploadUrl(URL_, usesTor)).resolves.toBe(URL_);
    expect(usesTor).not.toHaveBeenCalled();
  });
});
