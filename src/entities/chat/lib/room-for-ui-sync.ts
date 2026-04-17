import type { ChatRoom } from "../model/types";

/** Minimal store surface — avoids importing chat-store (circular deps). */
export type ChatStoreRoomLookup = {
  activeRoomId: string | null;
  activeRoom?: ChatRoom;
  sortedRooms: ChatRoom[];
};

/**
 * `activeRoom` (Matrix/roomsMap) can briefly lag `sortedRooms` (Dexie).
 * Use this anywhere the UI must match the chat list row (header, title recovery, etc.).
 */
export function getRoomForUiSync(store: ChatStoreRoomLookup): ChatRoom | undefined {
  const id = store.activeRoomId;
  if (!id) return undefined;
  if (store.activeRoom?.id === id) return store.activeRoom;
  return store.sortedRooms.find(r => r.id === id);
}
