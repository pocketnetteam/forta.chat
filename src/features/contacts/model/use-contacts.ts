import { ref } from "vue";
import { createAppInitializer } from "@/app/providers/initializers/app-initializer";
import { useUserStore } from "@/entities/user";
import { useAuthStore } from "@/entities/auth";
import { useChatStore } from "@/entities/chat";
import { getMatrixClientService } from "@/entities/matrix";
import { getmatrixid, hexEncode, tetatetid } from "@/shared/lib/matrix/functions";
import { MATRIX_SERVER } from "@/shared/config";

import type { User } from "@/entities/user";

let _appInit: ReturnType<typeof createAppInitializer> | null = null;
function getAppInit() {
  if (!_appInit) _appInit = createAppInitializer();
  return _appInit;
}

export function useContacts() {
  const userStore = useUserStore();
  const authStore = useAuthStore();
  const chatStore = useChatStore();
  const searchQuery = ref("");
  const searchResults = ref<User[]>([]);
  const isSearching = ref(false);
  const isCreatingRoom = ref(false);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const searchUsers = async (query: string) => {
    if (!query.trim()) {
      searchResults.value = [];
      return;
    }

    isSearching.value = true;
    try {
      const appInit = getAppInit();
      const results = await appInit.searchUsers(query.trim());

      // Filter out self
      const myAddress = authStore.address ?? "";
      searchResults.value = results
        .filter(u => u.address !== myAddress)
        .map(u => ({
          address: u.address,
          name: u.name || u.address,
          about: "",
          image: u.image,
          site: "",
          language: "",
        }));

      // Cache found users in user store
      for (const user of searchResults.value) {
        userStore.setUser(user.address, user);
      }

      // Supplement with cached users not already in results
      if (searchResults.value.length === 0) {
        const resultAddrs = new Set(searchResults.value.map(u => u.address));
        const cached = Object.values(userStore.users).filter(
          user =>
            !resultAddrs.has(user.address) &&
            user.address !== myAddress &&
            (user.name.toLowerCase().includes(query.toLowerCase()) ||
             user.address.toLowerCase().includes(query.toLowerCase()))
        );
        searchResults.value = [...searchResults.value, ...cached];
      }
    } catch {
      // Fallback to cached users
      searchResults.value = Object.values(userStore.users).filter(
        user =>
          user.name.toLowerCase().includes(query.toLowerCase()) ||
          user.address.toLowerCase().includes(query.toLowerCase())
      );
    } finally {
      isSearching.value = false;
    }
  };

  const debouncedSearch = (query: string) => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => searchUsers(query), 300);
  };

  /**
   * Helper: activate a room after join/rejoin — clears deleted state, adds to store, sets active.
   */
  const activateRoom = (roomId: string, targetAddress: string, myHexId: string, targetHexId: string) => {
    chatStore.clearDeletedRoom(roomId);
    const targetUser = userStore.getUser(targetAddress);
    chatStore.addRoom({
      id: roomId,
      name: targetUser?.name || targetAddress,
      avatar: `__pocketnet__:${targetAddress}`,
      unreadCount: 0,
      members: [myHexId, targetHexId],
      isGroup: false,
      updatedAt: Date.now(),
    });
    chatStore.setActiveRoom(roomId);
    chatStore.refreshRooms();
  };

  /**
   * Get or create a 1:1 room with the given address.
   * Uses deterministic room alias (tetatetid) matching bastyon-chat pattern:
   * - Create room with room_alias_name = SHA-224 hash of both users' hex IDs
   * - On M_ROOM_IN_USE (room was previously deleted/forgotten), rejoin via alias
   * Returns the room ID.
   */
  const getOrCreateRoom = async (targetAddress: string): Promise<string | null> => {
    isCreatingRoom.value = true;
    try {
      const matrixService = getMatrixClientService();
      const myUserId = matrixService.getUserId();
      if (!myUserId) return null;

      const targetHexId = hexEncode(targetAddress).toLowerCase();
      const myHexId = getmatrixid(myUserId); // already hexEncode(addr).toLowerCase()
      const targetMatrixId = `@${targetHexId}:${MATRIX_SERVER}`;

      // Compute deterministic alias for this 1:1 pair (same as bastyon-chat)
      const alias = tetatetid(myHexId, targetHexId);
      if (!alias) return null; // same user
      const fullAlias = `#${alias}:${MATRIX_SERVER}`;

      // Check existing local rooms for a 1:1 with this user (by alias/name match)
      const localRooms = matrixService.getRooms() as Array<Record<string, unknown>>;
      for (const room of localRooms) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const roomAny = room as any;
        const canonicalAlias = (roomAny.getCanonicalAlias?.() ?? "") as string;
        const roomName = (roomAny.name ?? "") as string;

        if (canonicalAlias.includes(alias) || roomName === "#" + alias) {
          const roomId = roomAny.roomId as string;
          const membership = roomAny.selfMembership ?? roomAny.getMyMembership?.();

          if (membership === "join") {
            activateRoom(roomId, targetAddress, myHexId, targetHexId);
            return roomId;
          }
        }
      }

      // Try to create the room. On M_ROOM_IN_USE, fall through to rejoin.
      try {
        const result = await matrixService.createRoom({
          room_alias_name: alias,
          visibility: "private",
          invite: [targetMatrixId],
          name: "#" + alias,
          initial_state: [
            {
              type: "m.set.encrypted",
              state_key: "",
              content: { encrypted: true },
            },
          ],
        });

        const roomId = result.room_id;

        // Set equal power levels for the invited user
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const newRoom = matrixService.getRoom(roomId) as any;
          if (newRoom) {
            const powerEvent = newRoom.currentState?.getStateEvents?.("m.room.power_levels");
            if (powerEvent?.length) {
              await matrixService.setPowerLevel(roomId, targetMatrixId, 100, powerEvent[0]);
            }
          }
        } catch { /* best-effort */ }

        activateRoom(roomId, targetAddress, myHexId, targetHexId);
        return roomId;
      } catch (createErr) {
        // Check for M_ROOM_IN_USE (alias already taken — room was previously deleted)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const errcode = (createErr as any)?.errcode ?? (createErr as any)?.data?.errcode;
        if (errcode !== "M_ROOM_IN_USE") {
          console.error("[useContacts] createRoom error:", createErr);
          return null;
        }
      }

      // M_ROOM_IN_USE: room alias exists on server from a previously deleted chat.
      // Strategy: try joinRoom first (works if the other user is still in the room).
      // If joinRoom fails (room is empty / dead), delete the alias and recreate.
      // If deleteAlias fails (no permission), fall back to versioned aliases.

      // Step 1: Try joinRoom via base alias (the other user may still be in the room)
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const joinResult = await matrixService.joinRoom(fullAlias) as any;
        const roomId = joinResult?.roomId ?? joinResult?.room_id ?? null;
        if (roomId) {
          activateRoom(roomId, targetAddress, myHexId, targetHexId);
          return roomId;
        }
      } catch (joinErr) {
        console.warn("[useContacts] joinRoom on base alias failed (room dead):", joinErr);
      }

      // Step 2: Room is dead (everyone left). Try to delete the old alias and recreate.
      const deleted = await matrixService.deleteAlias(fullAlias);
      if (deleted) {
        console.log("[useContacts] deleted stale alias, recreating:", fullAlias);
        try {
          const result = await matrixService.createRoom({
            room_alias_name: alias,
            visibility: "private",
            invite: [targetMatrixId],
            name: "#" + alias,
            initial_state: [
              {
                type: "m.set.encrypted",
                state_key: "",
                content: { encrypted: true },
              },
            ],
          });

          const roomId = result.room_id;
          console.log("[useContacts] recreated room after alias delete, roomId:", roomId);

          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const newRoom = matrixService.getRoom(roomId) as any;
            if (newRoom) {
              const powerEvent = newRoom.currentState?.getStateEvents?.("m.room.power_levels");
              if (powerEvent?.length) {
                await matrixService.setPowerLevel(roomId, targetMatrixId, 100, powerEvent[0]);
              }
            }
          } catch { /* best-effort */ }

          activateRoom(roomId, targetAddress, myHexId, targetHexId);
          return roomId;
        } catch (recreateErr) {
          console.warn("[useContacts] recreate after alias delete failed:", recreateErr);
        }
      }

      // Step 3: Fallback — try versioned aliases (deleteAlias may fail if we lack permission)
      for (let v = 2; v <= 100; v++) {
        const vAlias = tetatetid(myHexId, targetHexId, v);
        if (!vAlias) continue;
        const vFullAlias = `#${vAlias}:${MATRIX_SERVER}`;

        // Try joining first (the other user may have already created this version)
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const joinResult = await matrixService.joinRoom(vFullAlias) as any;
          const roomId = joinResult?.roomId ?? joinResult?.room_id ?? null;
          if (roomId) {
            activateRoom(roomId, targetAddress, myHexId, targetHexId);
            return roomId;
          }
        } catch { /* version doesn't exist or is dead */ }

        // Try deleting stale alias first, then creating
        await matrixService.deleteAlias(vFullAlias).catch(() => {});

        try {
          const result = await matrixService.createRoom({
            room_alias_name: vAlias,
            visibility: "private",
            invite: [targetMatrixId],
            name: "#" + vAlias,
            initial_state: [
              {
                type: "m.set.encrypted",
                state_key: "",
                content: { encrypted: true },
              },
            ],
          });

          const roomId = result.room_id;

          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const newRoom = matrixService.getRoom(roomId) as any;
            if (newRoom) {
              const powerEvent = newRoom.currentState?.getStateEvents?.("m.room.power_levels");
              if (powerEvent?.length) {
                await matrixService.setPowerLevel(roomId, targetMatrixId, 100, powerEvent[0]);
              }
            }
          } catch { /* best-effort */ }

          activateRoom(roomId, targetAddress, myHexId, targetHexId);
          return roomId;
        } catch (vErr) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const vErrcode = (vErr as any)?.errcode ?? (vErr as any)?.data?.errcode;
          if (vErrcode === "M_ROOM_IN_USE") {
            console.log("[useContacts] version %d also in use, trying next", v);
            continue;
          }
          console.error("[useContacts] createRoom v%d failed:", v, vErr);
          return null;
        }
      }

      console.error("[useContacts] exhausted all alias versions");
      return null;
    } catch (e) {
      console.error("[useContacts] getOrCreateRoom error:", e);
      return null;
    } finally {
      isCreatingRoom.value = false;
    }
  };

  return {
    isSearching,
    isCreatingRoom,
    searchQuery,
    searchResults,
    searchUsers,
    debouncedSearch,
    getOrCreateRoom,
  };
}
