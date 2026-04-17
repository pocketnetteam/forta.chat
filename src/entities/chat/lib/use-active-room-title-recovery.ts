import { computed, onUnmounted, watch } from "vue";
import { hexDecode, hexEncode } from "@/shared/lib/matrix/functions";
import { isUnresolvedName } from "./chat-helpers";
import { resolveMemberNamesForRoomTitle, resolveRoomDisplayName } from "./resolve-room-display-name";
import { markRoomTitlesGaveUp, roomTitleGaveUpIds } from "./room-title-gave-up";
import { useChatStore } from "../model/chat-store";
import { useUserStore } from "@/entities/user/model";
import { useAuthStore } from "@/entities/auth";
import { getRoomForUiSync } from "./room-for-ui-sync";

const MAX_NAME_RETRIES = 6;
const NAME_RETRY_BASE_MS = 2_000;

/**
 * When the chat header is open without the list driving retries, still run the same
 * profile/member reload chain and eventually mark the room gave-up so the title
 * matches the sidebar fallback instead of an infinite skeleton.
 */
export function useActiveRoomTitleRecovery(): void {
  const chatStore = useChatStore();
  const userStore = useUserStore();
  const authStore = useAuthStore();

  let timer: ReturnType<typeof setTimeout> | undefined;
  let attemptCount = 0;
  let chainGen = 0;

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const activeRawTitle = computed(() => {
    void chatStore.roomUiEpoch;
    const room = getRoomForUiSync(chatStore);
    const myHex = authStore.address ? hexEncode(authStore.address) : "";
    if (!room) return "";
    return resolveRoomDisplayName(room, userStore.users, myHex, a => chatStore.getDisplayName(a));
  });

  const runRetry = (roomId: string) => {
    chatStore.clearProfileCache([roomId]);
    chatStore.loadMembersForRooms([roomId]);
    const room = getRoomForUiSync(chatStore);
    if (!room || room.id !== roomId) return;
    const myHex = authStore.address ? hexEncode(authStore.address) : "";
    const addrs: string[] = [];
    for (const hexId of room.members) {
      if (hexId === myHex) continue;
      const addr = hexDecode(hexId);
      if (/^[A-Za-z0-9]+$/.test(addr) && !userStore.users[addr]?.name) addrs.push(addr);
    }
    if (addrs.length > 0) userStore.enqueueProfiles(addrs);
  };

  const scheduleChain = (roomId: string, gen: number) => {
    clearTimer();
    const room = getRoomForUiSync(chatStore);
    if (!room || room.id !== roomId || gen !== chainGen) return;

    const myHex = authStore.address ? hexEncode(authStore.address) : "";
    const getDm = (a: string) => chatStore.getDisplayName(a);
    const raw = resolveRoomDisplayName(room, userStore.users, myHex, getDm);
    if (!isUnresolvedName(raw)) return;
    if (roomTitleGaveUpIds.value.has(roomId)) return;
    if (resolveMemberNamesForRoomTitle(room, userStore.users, myHex, getDm).length > 0) return;

    if (attemptCount >= MAX_NAME_RETRIES) {
      markRoomTitlesGaveUp([roomId]);
      return;
    }

    const delay = NAME_RETRY_BASE_MS * Math.pow(2, attemptCount);
    timer = setTimeout(() => {
      timer = undefined;
      if (gen !== chainGen) return;
      const r = getRoomForUiSync(chatStore);
      if (!r || r.id !== roomId) return;
      const myH = authStore.address ? hexEncode(authStore.address) : "";
      const getDm = (a: string) => chatStore.getDisplayName(a);
      const rawNow = resolveRoomDisplayName(r, userStore.users, myH, getDm);
      if (!isUnresolvedName(rawNow)) return;
      if (roomTitleGaveUpIds.value.has(roomId)) return;
      if (resolveMemberNamesForRoomTitle(r, userStore.users, myH, getDm).length > 0) return;

      attemptCount++;
      runRetry(roomId);
      scheduleChain(roomId, gen);
    }, delay);
  };

  watch(
    () => chatStore.activeRoomId,
    (roomId) => {
      clearTimer();
      attemptCount = 0;
      chainGen++;
      if (!roomId) return;
      const gen = chainGen;
      scheduleChain(roomId, gen);
    },
    { immediate: true },
  );

  watch(activeRawTitle, (raw) => {
    if (!raw || !isUnresolvedName(raw)) {
      clearTimer();
      attemptCount = 0;
    }
  });

  onUnmounted(() => clearTimer());
}
