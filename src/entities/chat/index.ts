export * from "./model";
export type { ForwardingMessage } from "./model/types";
export { type DisplayResult, type DisplayState, getRoomTitleForUI, getUserDisplayNameForUI, getMessagePreviewForUI } from "./lib/display-result";
export { messageTypeFromMime, normalizeMime } from "./lib/chat-helpers";
export { default as RoomAvatar } from "./ui/RoomAvatar.vue";
export { resolveRoomDisplayName, resolveMemberNamesForRoomTitle } from "./lib/resolve-room-display-name";
export { roomTitleGaveUpIds, markRoomTitlesGaveUp } from "./lib/room-title-gave-up";
export { getRoomForUiSync, type ChatStoreRoomLookup } from "./lib/room-for-ui-sync";