import { describe, it, expect } from 'vitest';
import { scrubDecryptionError, summarizeDecryptionQueue } from '../collect-encryption-diagnostics';

/**
 * «Приходят зашифрованные сообщения» reports said nothing about encryption, so a missing room
 * key could not be told from a peer without keys. The report now sums up the decryption queue.
 */
describe('summarizeDecryptionQueue', () => {
  const HOUR = 3_600_000;
  const job = (roomId: string, status: string, lastError: string | undefined, createdAt: number) =>
    ({ roomId, status, lastError, createdAt });

  it('says nothing when nothing is waiting to be decrypted', () => {
    expect(summarizeDecryptionQueue([], 10 * HOUR)).toBeUndefined();
  });

  it('counts jobs by status, rooms, the oldest job and the most frequent reasons', () => {
    const jobs = [
      job('!a:s', 'dead', 'No common key event found for hash=0123456789abcdef0123', 1 * HOUR),
      job('!a:s', 'dead', 'No common key event found for hash=fedcba98765432100123', 4 * HOUR),
      job('!b:s', 'waiting', 'getusersinfo timeout', 9 * HOUR),
      job('!b:s', 'queued', undefined, 9 * HOUR),
    ];
    expect(summarizeDecryptionQueue(jobs, 10 * HOUR)).toEqual({
      queue: { dead: 2, waiting: 1, queued: 1 },
      roomsAffected: 2,
      oldestHours: 9,
      topErrors: [
        { error: 'No common key event found for hash=<hex>', count: 2 },
        { error: 'getusersinfo timeout', count: 1 },
      ],
    });
  });

  it('keeps at most five reasons', () => {
    const jobs = Array.from({ length: 8 }, (_, i) => job('!a:s', 'dead', `reason ${'x'.repeat(i + 1)}`, 0));
    expect(summarizeDecryptionQueue(jobs, HOUR)?.topErrors).toHaveLength(5);
  });
});

describe('scrubDecryptionError', () => {
  it('cuts event, room and user ids, hashes and keys out of an error', () => {
    const scrubbed = scrubDecryptionError(
      'decrypt $abcDEF123456789_xyz in !roomid:matrix.pocketnet.app from @50484c5637:matrix.pocketnet.app key QmFzZTY0QmFzZTY0QmFzZTY0QmFzZTY0 failed',
    );
    expect(scrubbed).not.toMatch(/matrix\.pocketnet|50484c|QmFzZ|abcDEF/);
    expect(scrubbed).toContain('failed');
  });

  it('bounds the length', () => {
    expect(scrubDecryptionError('e '.repeat(500)).length).toBeLessThanOrEqual(90);
  });
});
