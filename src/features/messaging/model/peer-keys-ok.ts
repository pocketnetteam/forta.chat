/** Peer-keys readiness gate for the send button.
 *
 *  Two regression contexts shaped this gate:
 *  - 1.10.16 reports of the send button stuck disabled with
 *    "Собеседник не опубликовал ключи шифрования" (issues #597/#598/#639).
 *    Root cause: peerKeysStatus stayed "missing" because peer keys never
 *    propagated, so the previous `status !== "missing"` UI gate locked the
 *    button forever and the user had no escape hatch.
 *  - Group rooms never required the gate to begin with — encryption falls
 *    back to plaintext for ≥50 members and is not mandatory for groups, yet
 *    the same gate blocked them too.
 *
 *  Resolution: only block in private 1:1 rooms AFTER a short grace period.
 *  Group/public rooms always allow send. Grace period gives peer keys time
 *  to land before the user perceives the button as broken. */
export type PeerKeysStatus =
  | "available"
  | "missing"
  | "not-encrypted"
  | "unknown"
  | undefined;

export interface PeerKeysOkInput {
  status: PeerKeysStatus;
  isGroupOrPublic: boolean;
  inGracePeriod: boolean;
}

export function isPeerKeysOk(input: PeerKeysOkInput): boolean {
  if (input.isGroupOrPublic) return true;
  if (input.inGracePeriod) return true;
  return input.status !== "missing";
}
