/** Typed view of the parts of the vendor Actions SDK
 *  (`public/js/lib/client/actions.js`) that registration drives, plus pure
 *  helpers that read a UserInfo action's state the way the vendor does.
 *
 *  Registration trusts the vendor's own engine: it queues the UserInfo action
 *  once, the SDK's 3-s `Account.processing()` loop sends it
 *  (`userInfo.sendWithNullStatus`), confirms it (`checkTransaction` /
 *  `Account.ws`) and persists it in localStorage (`actions_v0`). The app only
 *  observes the action — it never forces a send. */

export interface VendorUserInfoAction {
  id: string;
  transaction?: string | null;
  completed?: boolean;
  rejected?: unknown;
  rejectWait?: Date | string | null;
  sending?: Date | string | null;
  object?: { type?: string };
}

export interface VendorAccount {
  status: { value: boolean | null };
  unspents: { value: unknown[] };
  getStatus(): string;
  setStatus(value: boolean): void;
  updateUnspents(time?: number): Promise<unknown>;
  loadUnspents(): Promise<unknown>;
  willChangeUnspentsCallback(actionId: unknown, proxy: string): void;
  getTempUserInfo(): VendorUserInfoAction | null;
  getTempActions(type: string, filter: null, clear: true): VendorUserInfoAction[];
}

export type UserInfoActionState =
  | { kind: "queued"; sending: boolean }
  /** Rejected with a vendor "wait" code — the SDK clears it and retries itself after `rejectWait`. */
  | { kind: "waiting-retry" }
  | { kind: "sent"; txid: string }
  | { kind: "completed"; txid: string | null }
  | { kind: "rejected"; reason: unknown };

/** Same precedence as vendor `Action.processing()`: completed → rejected →
 *  transaction → still queued. */
export function readUserInfoActionState(action: VendorUserInfoAction): UserInfoActionState {
  if (action.completed) return { kind: "completed", txid: action.transaction ?? null };
  if (action.rejected) {
    if (action.rejectWait) return { kind: "waiting-retry" };
    return { kind: "rejected", reason: action.rejected };
  }
  if (action.transaction) return { kind: "sent", txid: action.transaction };
  return { kind: "queued", sending: !!action.sending };
}

/** Stable key of the observable state — the vendor re-emits `action` events on
 *  every internal bookkeeping change (roughly every 3-s loop tick), so callers
 *  compare keys to react only to real transitions. */
export function userInfoStateKey(state: UserInfoActionState): string {
  switch (state.kind) {
    case "queued":
      return state.sending ? "queued:sending" : "queued";
    case "sent":
      return `sent:${state.txid}`;
    case "completed":
      return `completed:${state.txid ?? ""}`;
    case "rejected":
      return `rejected:${String(state.reason)}`;
    case "waiting-retry":
      return "waiting-retry";
  }
}

/** `Account.getStatus()` values that mean the account is on-chain.
 *  'undefined_status' = a UserInfo action completed before `status.value`
 *  flipped (the vendor sets both in the same `change()` hook, but they can be
 *  read a tick apart). */
export function isRegistrationConfirmedStatus(status: string): boolean {
  return status === "registered" || status === "undefined_status";
}
