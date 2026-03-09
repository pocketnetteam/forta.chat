import { getPocketnetInstance } from "@/shared/api/sdk-bridge";
import { createAppInitializer } from "@/app/providers/initializers/app-initializer";
import { useAuthStore } from "@/entities/auth";

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

let _api: InstanceType<typeof Api> | null = null;

async function getApi() {
  if (_api) return _api;
  const inst = getPocketnetInstance();
  _api = new Api(inst);
  await _api.initIf();
  await _api.wait.ready("use", 5000);
  return _api;
}

function getAddress(): string {
  const addr = getPocketnetInstance().user.address.value;
  if (!addr) throw new Error("No user address");
  return addr;
}

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
  // Fully reactive: authStore fields are Vue refs, so the button
  // appears as soon as the user is authenticated + platform globals exist.
  const isAvailable = computed(() => {
    if (!authStore.address || !authStore.isAuthenticated) return false;
    try {
      return typeof bitcoin !== "undefined" && typeof Api !== "undefined";
    } catch {
      return false;
    }
  });

  /** Get current balance */
  const getBalance = async (): Promise<number> => {
    const api = await getApi();
    const address = getAddress();
    const info = await api.rpc("getaddressinfo", [address]);
    return (info as { balance: number }).balance;
  };

  /** Estimate fees for a transfer */
  const estimateFees = async (
    receiverAddress: string,
    amount: number,
    feeDirection: "include" | "exclude",
  ): Promise<number> => {
    const api = await getApi();
    const address = getAddress();

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
    const address = getAddress();

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

    return txId;
  };

  return { isAvailable, getBalance, estimateFees, sendTransfer };
}
