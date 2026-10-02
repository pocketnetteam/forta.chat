import type { ChatRoom } from "@/entities/chat";
import type { Channel } from "@/entities/channel";

function isChannel(item: ChatRoom | Channel): item is Channel {
  return "address" in item && !("id" in item);
}

/** Unified sort timestamp for a list item. */
export function getItemTimestamp(item: ChatRoom | Channel): number {
  if (isChannel(item)) {
    return item.lastContent ? item.lastContent.time * 1000 : 0;
  }
  return item.lastMessage?.timestamp ?? item.updatedAt;
}

/** Membership rank for tie-breaking: joined rooms > invites > channels. */
function membershipRank(item: ChatRoom | Channel): number {
  if (isChannel(item)) return 2;
  return item.membership === "invite" ? 1 : 0;
}

/**
 * "All" tab order: rooms (already sorted by activity upstream) merged with channels by time
 * desc, O(n+m) instead of re-sorting everything. Rooms keep their relative order from
 * `sortedRooms`; at equal timestamps a room goes before a channel.
 */
export function mergeRoomsAndChannels(
  rooms: readonly ChatRoom[],
  channels: readonly Channel[],
): (ChatRoom | Channel)[] {
  const sortedChannels = [...channels].sort((a, b) => getItemTimestamp(b) - getItemTimestamp(a));
  const merged: (ChatRoom | Channel)[] = [];
  let ri = 0, ci = 0;
  while (ri < rooms.length && ci < sortedChannels.length) {
    const rTs = getItemTimestamp(rooms[ri]);
    const cTs = getItemTimestamp(sortedChannels[ci]);
    if (rTs > cTs) {
      merged.push(rooms[ri++]);
    } else if (cTs > rTs) {
      merged.push(sortedChannels[ci++]);
    } else if (membershipRank(rooms[ri]) <= membershipRank(sortedChannels[ci])) {
      merged.push(rooms[ri++]);
    } else {
      merged.push(sortedChannels[ci++]);
    }
  }
  while (ri < rooms.length) merged.push(rooms[ri++]);
  while (ci < sortedChannels.length) merged.push(sortedChannels[ci++]);
  return merged;
}
