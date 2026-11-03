import { createServer } from 'node:http';
import { configFromEnv } from './config.ts';
import { createHandler, MAX_REQUEST_BYTES } from './handler.ts';

/**
 * Node entry for a host without Workers: `node src/node.ts` (Node 22.18 or
 * newer runs TypeScript as is). Put it behind a TLS reverse proxy and set
 * TRUST_PROXY=1 there, so the rate limit sees the client address.
 */
const handle = createHandler(configFromEnv(process.env));
const port = Number(process.env.PORT ?? 8787);
const trustProxy = process.env.TRUST_PROXY === '1';

const server = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_REQUEST_BYTES) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(chunk as Buffer);
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(name, value);
      else if (Array.isArray(value)) headers.set(name, value.join(', '));
    }
    const method = req.method ?? 'GET';
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const request = new Request(`http://localhost${req.url ?? '/'}`, {
      method,
      headers,
      body: hasBody ? new Uint8Array(Buffer.concat(chunks)) : undefined,
    });
    const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
    const response = await handle(request, forwarded || req.socket.remoteAddress || 'unknown');
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error('[bug-report-proxy] request failed:', e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

server.listen(port, () => console.info(`[bug-report-proxy] listening on port ${port}`));
