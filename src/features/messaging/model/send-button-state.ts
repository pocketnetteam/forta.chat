export interface SendButtonState {
  text: string;
  sending: boolean;
  showForwardPreview: boolean;
  showBulkForwardPreview: boolean;
  peerKeysOk: boolean;
}

const hasSendableContent = (s: Pick<SendButtonState, "text" | "showForwardPreview" | "showBulkForwardPreview">): boolean =>
  s.text.trim().length > 0 || s.showForwardPreview || s.showBulkForwardPreview;

export function isSendButtonVisible(s: SendButtonState): boolean {
  return hasSendableContent(s) || s.sending;
}

export function isSendButtonDisabled(s: SendButtonState): boolean {
  return !hasSendableContent(s) || s.sending || !s.peerKeysOk;
}
