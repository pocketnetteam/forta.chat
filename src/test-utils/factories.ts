/**
 * Test data factories for creating mock domain objects.
 */
import { MessageStatus, MessageType } from "@/entities/chat/model/types";
import type { Message, ChatRoom } from "@/entities/chat/model/types";

let msgCounter = 0;

/** Create a Message with sensible defaults, overridable via `overrides`. */
export function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: `msg_${++msgCounter}`,
    roomId: "!room:server",
    senderId: "user1",
    content: "hello",
    timestamp: Date.now(),
    status: MessageStatus.sent,
    type: MessageType.text,
    ...overrides,
  };
}

let roomCounter = 0;

/** Create a ChatRoom with sensible defaults. */
export function makeRoom(overrides: Partial<ChatRoom> = {}): ChatRoom {
  return {
    id: `!room_${++roomCounter}:server`,
    name: `Room ${roomCounter}`,
    unreadCount: 0,
    members: ["user1", "user2"],
    isGroup: false,
    updatedAt: Date.now(),
    ...overrides,
  };
}

/** Create a UTXO object for wallet tests. */
export function makeUTXO(overrides: Partial<{
  txid: string;
  vout: number;
  address: string;
  amount: number;
  amountSat: number;
  scriptPubKey: string;
  confirmations: number;
}> = {}) {
  return {
    txid: overrides.txid ?? `tx_${Math.random().toString(36).slice(2)}`,
    vout: overrides.vout ?? 0,
    address: overrides.address ?? "PMockAddress1234567890123456789012",
    amount: overrides.amount ?? 1.0,
    amountSat: overrides.amountSat ?? 100_000_000,
    scriptPubKey: overrides.scriptPubKey ?? "76a91400000000000000000000000000000000000000088ac",
    confirmations: overrides.confirmations ?? 10,
  };
}
