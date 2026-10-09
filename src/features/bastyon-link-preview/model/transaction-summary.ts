/**
 * Who paid whom how much, from a verbose `getrawtransaction` result —
 * the same reading as pocketnet's `transactionview` component:
 * senders are the inputs' addresses, recipients the outputs that carry value,
 * and an output back to a sender is change (hidden when anyone else is paid).
 */

export interface TransactionRecipient {
  address: string;
  /** PKOIN (coin units, as the verbose RPC returns them). */
  amount: number;
}

export interface TransactionSummary {
  txid: string;
  senders: string[];
  recipients: TransactionRecipient[];
  /** Sum of the shown recipients' amounts. */
  total: number;
  /** Unix seconds (`nTime` on Pocketnet nodes). */
  time?: number;
  /** Block the transaction was mined in; absent while it sits in the mempool. */
  height?: number;
  /** Only when the node reports it — Pocketnet nodes don't, see {@link confirmationsOf}. */
  confirmations?: number;
}

type RawInput = { address?: unknown };
type RawOutput = { value?: unknown; scriptPubKey?: { addresses?: unknown } };

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function outputAddress(output: RawOutput): string {
  const first = asArray(output.scriptPubKey?.addresses)[0];
  return typeof first === "string" ? first : "";
}

/** Exact PKOIN amount without float noise or trailing zeros: 20 → "20", 0.1 + 0.2 → "0.3". */
export function formatPkoinExact(amount: number): string {
  return Number(amount.toFixed(8)).toString();
}

export function summarizeTransaction(raw: unknown): TransactionSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const tx = raw as Record<string, unknown>;
  if (typeof tx.txid !== "string") return null;

  const senders: string[] = [];
  for (const input of asArray(tx.vin) as RawInput[]) {
    const address = typeof input?.address === "string" ? input.address : "";
    if (address && !senders.includes(address)) senders.push(address);
  }

  // Merge several outputs to one address into one row.
  const byAddress = new Map<string, number>();
  for (const output of asArray(tx.vout) as RawOutput[]) {
    const value = Number(output?.value);
    const address = output ? outputAddress(output) : "";
    if (!address || !Number.isFinite(value) || value <= 0) continue;
    byAddress.set(address, (byAddress.get(address) ?? 0) + value);
  }

  let recipients = [...byAddress].map(([address, amount]) => ({ address, amount }));
  const external = recipients.filter((r) => !senders.includes(r.address));
  if (external.length > 0) recipients = external;

  const total = recipients.reduce((sum, r) => sum + r.amount, 0);
  const confirmations = Number(tx.confirmations);
  const time = Number(tx.time ?? tx.blocktime ?? tx.nTime);
  // Mined = the node names the block. psdk (sdk.js transaction.load) fills a
  // mempool tx's `height` with the current block, so `height` alone can't tell.
  const height = tx.blockHash || tx.blockhash ? Number(tx.height) : NaN;

  return {
    txid: tx.txid,
    senders,
    recipients,
    total,
    time: Number.isFinite(time) && time > 0 ? time : undefined,
    height: Number.isFinite(height) && height > 0 ? height : undefined,
    confirmations: Number.isFinite(confirmations) && confirmations > 0 ? confirmations : undefined,
  };
}

/** Confirmations as the block explorer counts them: blocks from the
 *  transaction's block to the chain tip, inclusive. 0 = not mined yet.
 *  A tip behind the transaction (our node lags the sender's) still counts 1;
 *  an unknown tip (0) falls back to the node's own count, if any. */
export function confirmationsOf(summary: TransactionSummary, tip: number): number {
  if (summary.height && tip > 0) return Math.max(tip - summary.height + 1, 1);
  if (summary.confirmations) return summary.confirmations;
  return summary.height ? 1 : 0;
}
