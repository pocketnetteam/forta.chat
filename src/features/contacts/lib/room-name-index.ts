import type { ChatRoom } from "@/entities/chat";

/** Resolved title of a room plus whether any member name is known yet. */
export interface RoomNameInfo {
  name: string;
  /** False when no member name could be resolved and the title depends on them —
   *  the row waits for profiles / members. Always true for a group with its own name. */
  hasMemberNames: boolean;
}

interface MemoEntry<C> {
  context: C;
  members: ChatRoom["members"];
  invitedMembers: ChatRoom["invitedMembers"];
  name: string;
  avatar: ChatRoom["avatar"];
  isGroup: boolean;
  info: RoomNameInfo;
}

export function sameSet<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/**
 * Room names for the chat list, resolved on demand and memoized per room.
 *
 * Only rows that are displayed ask for a name. Resolving every room up front (thousands
 * with invites) re-ran on each profile batch, since a new profile changes the context,
 * and took tens of ms per pass. A room's name depends only on its member lists, name,
 * avatar and group flag, plus the global name sources (`context`): the memo entry is
 * reused while those fields are the same and the context object is the same one. Member
 * arrays are reassigned on change, never mutated in place, so a reference check is enough.
 */
export function createRoomNameResolver<C>(resolve: (room: ChatRoom, context: C) => RoomNameInfo) {
  const memo = new Map<string, MemoEntry<C>>();

  return (room: ChatRoom, context: C): RoomNameInfo => {
    const entry = memo.get(room.id);
    if (
      entry
      && entry.context === context
      && entry.members === room.members
      && entry.invitedMembers === room.invitedMembers
      && entry.name === room.name
      && entry.avatar === room.avatar
      && entry.isGroup === room.isGroup
    ) {
      return entry.info;
    }
    const info = resolve(room, context);
    memo.set(room.id, {
      context,
      members: room.members,
      invitedMembers: room.invitedMembers,
      name: room.name,
      avatar: room.avatar,
      isGroup: room.isGroup,
      info,
    });
    return info;
  };
}
