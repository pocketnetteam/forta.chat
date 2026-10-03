/**
 * Ask the app shell to open a room from inside the UI (e.g. a room link card
 * in a message). App.vue listens and runs the same pipeline as a /join deep
 * link: jump to the room when already a member, otherwise the join preview
 * modal with its error handling.
 */
export const JOIN_ROOM_REQUEST_EVENT = "forta:join-room";

export function requestJoinRoom(roomId: string): void {
  if (!roomId) return;
  window.dispatchEvent(new CustomEvent(JOIN_ROOM_REQUEST_EVENT, { detail: { roomId } }));
}
