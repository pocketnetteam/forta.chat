export function shouldShowPeerRenamePencil(
  isGroup: boolean,
  peerAddress: string | null | undefined,
  myAddress: string | null | undefined,
): boolean {
  if (isGroup) return false;
  if (!peerAddress) return false;
  if (!myAddress) return false;
  return peerAddress !== myAddress;
}
