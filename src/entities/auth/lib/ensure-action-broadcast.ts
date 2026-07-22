/** Ensure a queued Actions SDK action actually broadcasts.
 *
 *  Why: `addActionAndSendIfCan` only calls `processingWithIterations` when
 *  `checkAccountReadySend()` is true — which requires `status.value` (already
 *  registered). New registration accounts always take the else branch and only
 *  queue the action, resolving immediately with no txid. Our registration poll
 *  then moved to "confirming" and spun forever waiting for an on-chain UserInfo
 *  that was never sent.
 *
 *  Force the send path (same work the SDK's 3s `processing()` interval would
 *  eventually attempt) and require a concrete outcome: txid, completed, or
 *  rejected — so callers cannot treat a silent queue as success.
 */

export interface BroadcastableAction {
  transaction?: string | null;
  completed?: boolean;
  rejected?: unknown;
  processingWithIterations?: (
    rejectIfError?: boolean | string[],
  ) => Promise<void>;
}

export async function ensureActionBroadcast(
  action: BroadcastableAction | null | undefined,
): Promise<BroadcastableAction> {
  if (!action) {
    throw new Error("No action returned from addActionAndSendIfCan");
  }

  if (action.transaction || action.completed) return action;
  if (action.rejected) throw new Error(String(action.rejected));

  if (typeof action.processingWithIterations === "function") {
    try {
      await action.processingWithIterations(true);
    } catch (e) {
      if (action.rejected) throw new Error(String(action.rejected));
      if (action.transaction || action.completed) return action;
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  if (action.rejected) throw new Error(String(action.rejected));
  if (action.transaction || action.completed) return action;

  throw new Error("UserInfo broadcast did not produce a transaction");
}
