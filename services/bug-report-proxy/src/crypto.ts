const encoder = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
  let hex = '';
  for (const byte of signature) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Key that lets the reporter close or reopen one issue. The proxy returns it
 * once, when it creates the issue; the app keeps it on the device.
 */
export async function manageKeyFor(secret: string, repo: string, issueNumber: number): Promise<string> {
  return (await hmacHex(secret, `manage:${repo}#${issueNumber}`)).slice(0, 32);
}

/**
 * Marker that groups the reports of one reporter. The app sends a SHA-256 of
 * the address with a public salt, and anyone with a list of the public Bastyon
 * addresses can compute that. The keyed hash cannot be computed without the
 * proxy secret.
 */
export async function reporterMarkerFor(secret: string, reporterHash: string): Promise<string> {
  return (await hmacHex(secret, `reporter:${reporterHash}`)).slice(0, 16);
}

/** Compares in time that does not depend on where the strings differ. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
