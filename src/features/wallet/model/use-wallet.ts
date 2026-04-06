import { computed, toRef } from "vue";
import { storeToRefs } from "pinia";
import { getPocketnetInstance } from "@/shared/api/sdk-bridge";
import { useAuthStore } from "@/entities/auth";
import { useWalletStore, getApi } from "./wallet-store";

export interface UTXO {
  txid: string;
  vout: number;
  address: string;
  amount: number;
  amountSat: number;
  scriptPubKey: string;
  confirmations: number;
}

export const SATOSHI = 100_000_000;
const MAX_FEE = 0.0999;
export const DUST_LIMIT = 700; // satoshis

function getKeyPair() {
  const inst = getPocketnetInstance();
  if (!inst.user.keys) throw new Error("No signing keys");
  return inst.user.keys();
}

/** Select UTXOs to cover targetSat, returns [selected, totalSat] */
export function selectUtxos(utxos: UTXO[], targetSat: number): [UTXO[], number] {
  // Sort by amount descending — prefer fewer, larger UTXOs
  const sorted = [...utxos].sort((a, b) => b.amountSat - a.amountSat);
  const selected: UTXO[] = [];
  let sum = 0;
  for (const u of sorted) {
    selected.push(u);
    sum += u.amountSat;
    if (sum >= targetSat) break;
  }
  if (sum < targetSat) throw new Error("Insufficient balance");
  return [selected, sum];
}

/** Build a raw transaction, returns { hex, virtualSize, txId } */
function buildTx(
  inputs: UTXO[],
  receiverAddress: string,
  amountSat: number,
  feeSat: number,
  senderAddress: string,
) {
  const keyPair = getKeyPair();
  const txb = new bitcoin.TransactionBuilder();

  for (const input of inputs) {
    txb.addInput(input.txid, input.vout, null, Buffer.from(input.scriptPubKey, "hex"));
  }

  // Receiver output
  txb.addOutput(receiverAddress, amountSat);

  // Change output
  const totalIn = inputs.reduce((s, u) => s + u.amountSat, 0);
  const change = totalIn - amountSat - feeSat;
  if (change > DUST_LIMIT) {
    txb.addOutput(senderAddress, change);
  }

  // Sign all inputs
  for (let i = 0; i < inputs.length; i++) {
    txb.sign(i, keyPair);
  }

  const tx = txb.build();
  return { hex: tx.toHex(), virtualSize: tx.virtualSize(), txId: tx.getId() };
}

export function useWallet() {
  const authStore = useAuthStore();
  const walletStore = useWalletStore();

  function requireAddress(): string {
    const addr = authStore.address;
    if (!addr) throw new Error("No user address");
    return addr;
  }

  /** Estimate fees for a transfer */
  const estimateFees = async (
    receiverAddress: string,
    amount: number,
    feeDirection: "include" | "exclude",
  ): Promise<number> => {
    const api = await getApi();
    const address = requireAddress();

    // Get fee rate
    const feeResult = await api.rpc("estimatesmartfee", [6]) as { feerate: number };
    const feerate = feeResult.feerate;

    // Get UTXOs
    const utxos = (await api.rpc("txunspent", [[address], 1, 9999999])) as UTXO[];

    // Figure out how much we need
    const amountSat = Math.round(amount * SATOSHI);
    // For estimation, use a rough fee so we can select UTXOs
    const roughFeeSat = Math.round(0.001 * SATOSHI);
    const targetSat = feeDirection === "include" ? amountSat : amountSat + roughFeeSat;
    const [selected] = selectUtxos(utxos, targetSat);

    // Build a dummy tx to get virtualSize
    const dummyFeeSat = roughFeeSat;
    const { virtualSize } = buildTx(selected, receiverAddress, amountSat, dummyFeeSat, address);

    const totalFee = Math.min(virtualSize * feerate, MAX_FEE);
    return totalFee;
  };

  /** Send PKOIN transfer. Returns txId on success. */
  const sendTransfer = async (
    receiverAddress: string,
    amount: number,
    feeDirection: "include" | "exclude",
    _message?: string,
  ): Promise<string> => {
    const api = await getApi();
    const address = requireAddress();

    // Get fee rate + UTXOs + balance in parallel
    const [feeResult, utxos, balanceInfo] = await Promise.all([
      api.rpc("estimatesmartfee", [6]) as Promise<{ feerate: number }>,
      api.rpc("txunspent", [[address], 1, 9999999]) as Promise<UTXO[]>,
      api.rpc("getaddressinfo", [address]) as Promise<{ balance: number }>,
    ]);

    const feerate = feeResult.feerate;
    const balance = balanceInfo.balance;
    const amountSat = Math.round(amount * SATOSHI);

    // First pass: estimate fee with rough size
    const roughFeeSat = Math.round(0.002 * SATOSHI);
    const targetSat = feeDirection === "include" ? amountSat : amountSat + roughFeeSat;
    const [selected] = selectUtxos(utxos, targetSat);

    // Build tx to get actual size
    const { virtualSize } = buildTx(selected, receiverAddress, amountSat, roughFeeSat, address);
    const feeSat = Math.round(Math.min(virtualSize * feerate, MAX_FEE) * SATOSHI);

    // Apply fee direction
    const actualAmountSat = feeDirection === "include" ? amountSat - feeSat : amountSat;
    const totalNeeded = feeDirection === "include" ? amount : amount + feeSat / SATOSHI;

    if (actualAmountSat <= DUST_LIMIT) throw new Error("Amount too small after fees");
    if (totalNeeded > balance) throw new Error("Insufficient balance");

    // Re-select UTXOs with correct fee
    const finalTargetSat = actualAmountSat + feeSat;
    const [finalInputs] = selectUtxos(utxos, finalTargetSat);

    // Build final transaction
    const { hex, txId } = buildTx(finalInputs, receiverAddress, actualAmountSat, feeSat, address);

    // Broadcast
    await api.rpc("sendrawtransaction", [hex]);

    // Refresh wallet balance after successful broadcast
    walletStore.refresh();

    return txId;
  };

  const { isAvailable, balance, status } = storeToRefs(walletStore);

  return {
    isAvailable,
    balance,
    status,
    refresh: walletStore.refresh,
    estimateFees,
    sendTransfer,
  };
}
