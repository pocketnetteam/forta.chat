/** Ensure a queued Actions SDK action actually broadcasts.
 *
 *  Why: `addActionAndSendIfCan` only calls `processingWithIteractions` when
 *  `checkAccountReadySend()` is true — which requires `status.value` (already
 *  registered). New registration accounts always take the else branch and only
 *  queue the action, resolving immediately with no txid. Our registration poll
 *  then moved to "confirming" and spun forever waiting for an on-chain UserInfo
 *  that was never sent.
 *
 *  Force the send path (same work the SDK's 3s `processing()` interval would
 *  eventually attempt) and require a concrete outcome: txid, completed, or
 *  rejected — so callers cannot treat a silent queue as success.
 *
 *  NB: the vendor method is spelled `processingWithIteractions` (actions.js —
 *  not a typo we get to fix, it's the real name on the object at runtime).
 *  The correctly-spelled `processingWithIterations` never existed on the
 *  vendor action, so this call silently no-op'd — every broadcast fell
 *  through to "did not produce a transaction" immediately, and every
 *  registration poll retry queued a brand new UserInfo action instead of
 *  ever actually forcing the first one to send, piling up actions the
 *  vendor's own collision guard then rejected ("actions_collision").
 */

export interface BroadcastableAction {
  transaction?: string | null;
  completed?: boolean;
  rejected?: unknown;
  processingWithIteractions?: (
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

  if (typeof action.processingWithIteractions === "function") {
    try {
      await action.processingWithIteractions(true);
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
