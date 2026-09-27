import type { PeerKeysStatus } from "../model/types";

export interface PeerKeysStatusInput {
  /** roomCrypto.canBeEncrypt() */
  canEncrypt: boolean;
  /** roomCrypto.membersLoaded?.() — undefined when the room crypto can't tell. */
  membersLoaded: boolean | undefined;
  /** Joined member count from the Matrix room summary. */
  memberCount: number;
}

/**
 * Peer-keys status of a non-public room. "Profiles still loading" is reported
 * as "unknown", not "missing": canBeEncrypt() stays false until every member's
 * profile has loaded (audit S1-01), and pcrypto.onKeysLoaded re-runs the check
 * once they land, so treating the loading window as "missing" only flashed a
 * false "hasn't published keys" banner (audit S7-03 follow-up).
 */
export function decidePeerKeysStatus(input: PeerKeysStatusInput): PeerKeysStatus {
  if (input.canEncrypt) return "available";
  if (input.memberCount >= 50) return "not-encrypted";
  if (input.membersLoaded === false) return "unknown";
  return "missing";
}
