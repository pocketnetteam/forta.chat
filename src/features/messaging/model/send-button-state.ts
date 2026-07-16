export interface SendButtonState {
  text: string;
  sending: boolean;
  showForwardPreview: boolean;
  showBulkForwardPreview: boolean;
  peerKeysOk: boolean;
  /** Active external share from Android Share Sheet — bypass peerKeysOk gate
   *  because the user explicitly picked the target room. SyncEngine retries
   *  the encrypted send with exponential backoff while peer keys propagate,
   *  and on terminal failure the message lands as a "failed" bubble with a
   *  visible retry — strictly better UX than the previous silent no-op when
   *  the user tapped Send before keys arrived (Session 48 / #717 #710 #706). */
  isExternalShare?: boolean;
}

const hasSendableContent = (s: Pick<SendButtonState, "text" | "showForwardPreview" | "showBulkForwardPreview">): boolean =>
  s.text.trim().length > 0 || s.showForwardPreview || s.showBulkForwardPreview;

export function isSendButtonVisible(s: SendButtonState): boolean {
  return hasSendableContent(s) || s.sending;
}

export function isSendButtonDisabled(s: SendButtonState): boolean {
  if (!hasSendableContent(s)) return true;
  if (s.sending) return true;
  if (s.isExternalShare) return false;
  return !s.peerKeysOk;
}
