import { configFromEnv, type ProxyEnv } from './config.ts';
import { createHandler, type Handler } from './handler.ts';

/** Cloudflare Worker entry. One handler per isolate keeps the rate limits counting. */
let handle: Handler | null = null;

export default {
  async fetch(request: Request, env: ProxyEnv): Promise<Response> {
    try {
      handle ??= createHandler(configFromEnv(env));
    } catch (e) {
      console.error('[bug-report-proxy] misconfigured:', e);
      return new Response(JSON.stringify({ error: 'misconfigured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
    return handle(request, request.headers.get('CF-Connecting-IP') ?? 'unknown');
  },
};
