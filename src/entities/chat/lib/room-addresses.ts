import { addressFromMatrixId, eventKeyAddresses } from "@/shared/lib/matrix/pcrypto-recipients";

/** Pcrypto does not encrypt rooms with this many members, so their keys are never needed. */
export const KEYS_MAX_MEMBERS = 50;

export interface RoomAddressSources {
  /** Addresses from the SDK member list (chat-store `matrixRoomAddresses`). */
  sdkAddresses?: readonly string[];
  /** Hex member ids of the stored ChatRoom (Dexie, shrink-protected). */
  memberHexIds?: readonly string[];
  /** Raw live-timeline events: their senders and Pcrypto recipients. */
  events?: readonly (Record<string, unknown> | null | undefined)[];
}

/**
 * Every participant address known for a room, from all sources at once.
 * With lazy-loaded members the SDK list of a 1:1 room can hold only the own
 * user — a non-empty list that used to hide the peer still present in the
 * stored room or in the encrypted events.
 */
export function roomAddresses(sources: RoomAddressSources): string[] {
  const out = new Set<string>(sources.sdkAddresses ?? []);
  for (const hexId of sources.memberHexIds ?? []) {
    const addr = addressFromMatrixId(hexId);
    if (addr) out.add(addr);
  }
  for (const addr of eventKeyAddresses(sources.events ?? [])) out.add(addr);
  return [...out];
}

/**
 * Addresses whose keys a batched preload should fetch for these rooms:
 * every participant except `myAddress`, skipping rooms Pcrypto leaves
 * unencrypted (by the server's joined count, or the known participants —
 * the local list alone undercounts a lazy-loaded group).
 */
export function roomsKeyAddresses(
  rooms: readonly { addresses: readonly string[]; joinedCount: number }[],
  myAddress: string | null | undefined,
): string[] {
  const out = new Set<string>();
  for (const room of rooms) {
    if (Math.max(room.joinedCount, room.addresses.length) >= KEYS_MAX_MEMBERS) continue;
    for (const addr of room.addresses) out.add(addr);
  }
  if (myAddress) out.delete(myAddress);
  return [...out];
}
