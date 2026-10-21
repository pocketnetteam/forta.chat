import { describe, it, expect } from 'vitest';
import { scrubPii } from '../scrub-pii';

describe('scrubPii', () => {
  it.each([
    ['a Matrix user ID', 'from @a1b2c3d4:matrix.pocketnet.app here', 'from <user> here'],
    ['a room ID in a route', '/chat?room=!AbCdEf123:matrix.pocketnet.app', '/chat?room=<room>'],
    ['a room alias', 'joined #general:matrix.org', 'joined <alias>'],
    ['an event ID', 'reply to $Xy1Zab2Cd3Ef4Gh5Ij6Kl7Mn8Op9Qr0StUvWxYz012', 'reply to <event>'],
    ['a Bastyon address', 'my address PQ8AiCHJaTZAThr2TnpkQYDyVd1Hidq4PM ok', 'my address <address> ok'],
    ['a media link', 'image mxc://matrix.org/AbCdEf123 failed', 'image <media> failed'],
    ['an e-mail address', 'write to alex.d@example.com', 'write to <email>'],
    ['an access token parameter', 'GET /sync?access_token=syt_abc_123&since=1', 'GET /sync?access_token=<token>&since=1'],
    ['a bare Synapse token', 'token syt_YWxpY2U_abcDEF_123 leaked', 'token <token> leaked'],
    ['an IPv4 address', 'candidate 192.168.1.20 udp', 'candidate <ip> udp'],
  ])('replaces %s', (_name, input, expected) => {
    expect(scrubPii(input)).toBe(expected);
  });

  it('keeps what triage reads: versions, headings, call IDs, issue references', () => {
    const text = [
      '## Description',
      '| Version | 1.13.9 |',
      'Mozilla/5.0 (Linux; Android 14; SM-A528B) Chrome/131.0.0.0 Mobile Safari/537.36',
      '| 1 | `c1728390abcd` | 1200 | no | high | rang |',
      'see forta-bugs#460, costs $5',
    ].join('\n');
    expect(scrubPii(text)).toBe(text);
  });

  it('scrubs every occurrence', () => {
    expect(scrubPii('@a:x.org and @b:y.org')).toBe('<user> and <user>');
  });
});
