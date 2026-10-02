import type { ChatRoom } from "@/entities/chat";

/** Resolved title of a room plus whether any member name is known yet. */
export interface RoomNameInfo {
  name: string;
  /** No member name could be resolved — the row waits for profiles / members. */
  hasMemberNames: boolean;
}

export interface RoomNameIndex {
  /** room id → resolved title. Same reference while no title changed. */
  names: Record<string, string>;
  /** Rooms without any resolved member name. Same reference while the set is unchanged. */
  unresolved: ReadonlySet<string>;
}

interface MemoEntry {
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
 * Room names for the chat list, resolved once per room instead of once per room per update.
 *
 * Every room patch (a receipt, a new message, a decrypted preview) hands the list a new
 * `sortedRooms` array; resolving the names of thousands of rooms (invites included) on each
 * one took ~40 ms per mounted tab. A room's name depends only on its member lists, name,
 * avatar and group flag, plus the global name sources (`context`): the memo entry is reused
 * while those fields are the same and the context object is the same one. Member arrays are
 * reassigned on change, never mutated in place, so a reference check is enough.
 */
export function createRoomNameIndex<C>(resolve: (room: ChatRoom, context: C) => RoomNameInfo) {
  const memo = new Map<string, MemoEntry>();
  let lastContext: C | undefined;
  let result: RoomNameIndex = { names: {}, unresolved: new Set() };

  return (rooms: readonly ChatRoom[], context: C): RoomNameIndex => {
    if (context !== lastContext) {
      memo.clear();
      lastContext = context;
    }
    const names: Record<string, string> = {};
    const unresolved = new Set<string>();
    let namesChanged = false;
    for (const room of rooms) {
      let entry = memo.get(room.id);
      if (
        !entry
        || entry.members !== room.members
        || entry.invitedMembers !== room.invitedMembers
        || entry.name !== room.name
        || entry.avatar !== room.avatar
        || entry.isGroup !== room.isGroup
      ) {
        entry = {
          members: room.members,
          invitedMembers: room.invitedMembers,
          name: room.name,
          avatar: room.avatar,
          isGroup: room.isGroup,
          info: resolve(room, context),
        };
        memo.set(room.id, entry);
      }
      names[room.id] = entry.info.name;
      if (!namesChanged && result.names[room.id] !== entry.info.name) namesChanged = true;
      if (!entry.info.hasMemberNames) unresolved.add(room.id);
    }
    // Same names for every room and same count → no room was removed either.
    if (!namesChanged && Object.keys(result.names).length !== rooms.length) namesChanged = true;
    if (memo.size > rooms.length) {
      for (const id of memo.keys()) if (!(id in names)) memo.delete(id);
    }
    const nextNames = namesChanged ? names : result.names;
    const nextUnresolved = sameSet(result.unresolved, unresolved) ? result.unresolved : unresolved;
    if (nextNames !== result.names || nextUnresolved !== result.unresolved) {
      result = { names: nextNames, unresolved: nextUnresolved };
    }
    return result;
  };
}
