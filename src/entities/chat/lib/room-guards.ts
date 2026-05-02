import { getMatrixClientService } from "@/entities/matrix";
import { getMemberPowerLevel } from "@/entities/matrix/model/matrix-kit";

/**
 * Check if a user is banned in a room by reading the m.room.member state event.
 * Reads directly from room state, not cache.
 */
export function isUserBanned(roomId: string, matrixUserId: string): boolean {
  try {
    const matrixService = getMatrixClientService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const matrixRoom = matrixService.getRoom(roomId) as any;
    if (!matrixRoom) return false;
    const memberEvent = matrixRoom.currentState?.getStateEvents?.("m.room.member", matrixUserId);
    const membership = memberEvent?.getContent?.()?.membership ?? memberEvent?.event?.content?.membership;
    return membership === "ban";
  } catch {
    return false;
  }
}

/**
 * Reset a user's power level to 0 (default) before kick/ban.
 * Prevents resurrection bug where kicked admin retains elevated PL.
 *
 * Uses SDK's `RoomMember.powerLevel` instead of exact-match `users[id]` so the
 * elevated check fires correctly in legacy bastyon-chat rooms whose
 * `power_levels.users` map keys admins by a different Matrix domain.
 */
export async function resetPowerLevel(roomId: string, matrixUserId: string): Promise<void> {
  try {
    const matrixService = getMatrixClientService();
    const matrixRoom = matrixService.getRoom(roomId) as Record<string, unknown> | null;
    if (!matrixRoom) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const powerEvent = (matrixRoom as any).currentState?.getStateEvents?.("m.room.power_levels", "");
    if (!powerEvent) return;
    // Only reset if user has elevated power level (per SDK resolution)
    if (getMemberPowerLevel(matrixRoom, matrixUserId) > 0) {
      await matrixService.setPowerLevel(roomId, matrixUserId, 0, powerEvent);
    }
  } catch (e) {
    console.warn("[room-guards] resetPowerLevel failed:", e);
  }
}
