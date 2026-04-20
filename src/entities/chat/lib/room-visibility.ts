import type { ChatRoom } from "@/entities/chat/model/types";

export type ContactListTab = "all" | "personal" | "groups" | "invites" | "channels";

/**
 * Whether a room has ANY content worth rendering.
 *
 * Purpose: prevent blank 68px slots in the virtual list.
 * `RecycleScroller` reserves a fixed-height slot per item, so an item with no
 * name, no `lastMessage`, and `updatedAt=0` renders as an empty stripe —
 * visually identical to a hole between real chats. This guard drops those
 * placeholder rooms (they survive in Dexie for eventual hydration but are
 * not something the user can act on yet).
 *
 * A room is displayable if any of the following hold:
 *   - it has a `lastMessage` (timeline content is available);
 *   - it has a non-zero `updatedAt` (even an empty invite has an origin ts);
 *   - it has a non-empty name (even an unresolved Matrix ID is a skeleton hint).
 */
export function hasDisplayableContent(room: ChatRoom): boolean {
  if (room.lastMessage) return true;
  if ((room.updatedAt ?? 0) > 0) return true;
  const name = room.name?.trim() ?? "";
  if (name === "" || name === "-") return false;
  return true;
}

/**
 * Filter `rooms` for a given sidebar tab.
 *
 * Rules:
 *   - "all": hide invites (they live on the dedicated Invites tab) and hide
 *     empty placeholder rooms. This removes the blank stripes between chats.
 *   - "personal": 1:1 chats, joined membership only, displayable content.
 *   - "groups": group chats, joined membership only, displayable content.
 *   - "invites": ALL invites (even empty ones — the user still needs to
 *     accept/decline them). No displayability filter.
 *   - "channels": no room filter (channels live in a separate store).
 */
export function filterRoomsForTab(rooms: ChatRoom[], tab: ContactListTab): ChatRoom[] {
  if (tab === "invites") {
    return rooms.filter(r => r.membership === "invite");
  }
  if (tab === "channels") {
    return [];
  }
  const base = rooms.filter(r => r.membership !== "invite" && hasDisplayableContent(r));
  if (tab === "personal") return base.filter(r => !r.isGroup);
  if (tab === "groups") return base.filter(r => r.isGroup);
  return base;
}
