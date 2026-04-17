import { ref, triggerRef } from "vue";

/** Rooms where name resolution exhausted retries — shared by list + header. */
export const roomTitleGaveUpIds = ref(new Set<string>());

export function markRoomTitlesGaveUp(roomIds: string[]): void {
  let changed = false;
  for (const id of roomIds) {
    if (!roomTitleGaveUpIds.value.has(id)) {
      roomTitleGaveUpIds.value.add(id);
      changed = true;
    }
  }
  if (changed) triggerRef(roomTitleGaveUpIds);
}
