import { ref } from "vue";
import { createAppInitializer } from "@/app/providers/initializers/app-initializer";
import { useUserStore } from "@/entities/user";
import { useAuthStore } from "@/entities/auth";
import { useChatStore } from "@/entities/chat";
import { getMatrixClientService } from "@/entities/matrix";
import { getmatrixid, hexDecode, hexEncode, tetatetid } from "@/shared/lib/matrix/functions";
import { MATRIX_SERVER } from "@/shared/config";
import { isChatDbReady, getChatDb, type CachedSearchUser } from "@/shared/lib/local-db";
import type { TranslationKey } from "@/shared/lib/i18n";

import type { User } from "@/entities/user";

let _appInit: ReturnType<typeof createAppInitializer> | null = null;
function getAppInit() {
  if (!_appInit) _appInit = createAppInitializer();
  return _appInit;
}

/** Bastyon addresses are ~34-char alphanumeric strings (base58-flavoured)
 *  typically starting with "P". We allow `[A-Za-z0-9]{25,40}` as a defensive
 *  filter — wide enough for version drift, strict enough to reject multibyte
 *  Unicode, control bytes, or anything else a malicious homeserver might
 *  inject via the user_directory response (results end up stored in Dexie
 *  and rendered in Vue). */
const BASTYON_ADDRESS_RE = /^[A-Za-z0-9]{25,40}$/;

/** Turn a Matrix user directory result into a local User shape.
 *  Matrix user_id format: @<hex-address>:<server>. We decode the hex back
 *  to a Bastyon address using the shared `hexDecode` (which mirrors
 *  `hexEncode`'s 0x350 offset), then validate against the Bastyon shape. */
function normalizeMatrixDirectoryUser(entry: { user_id: string; display_name?: string; avatar_url?: string }): { address: string; name: string; image: string } | null {
  // Extract hex localpart from @<localpart>:<server>
  const m = /^@([^:]+):/.exec(entry.user_id);
  if (!m) return null;
  const hex = m[1].toLowerCase();
  // Cap raw hex length: a valid Bastyon-encoded localpart is at most ~80 hex
  // chars (40 bytes). Refuse anything larger to avoid unbounded allocation.
  if (!hex || hex.length > 80 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) return null;

  let address: string;
  try {
    address = hexDecode(hex);
  } catch {
    return null;
  }
  if (!BASTYON_ADDRESS_RE.test(address)) return null;

  return {
    address,
    name: entry.display_name && entry.display_name !== entry.user_id ? entry.display_name : address,
    image: entry.avatar_url ?? "",
  };
}

function dedupeByAddress<T extends { address: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (!item.address) continue;
    const key = item.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function useContacts() {
  const userStore = useUserStore();
  const authStore = useAuthStore();
  const chatStore = useChatStore();
  const searchQuery = ref("");
  const searchResults = ref<User[]>([]);
  const isSearching = ref(false);
  const isCreatingRoom = ref(false);
  /** i18n key for the last search failure (null on success). UI reads this to
   *  localize user-facing errors instead of surfacing raw SDK strings such as
   *  "Невозможно разыскать идентификатор". */
  const searchError = ref<TranslationKey | null>(null);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Monotonic counter — every searchUsers() call grabs the next value and
   *  compares it to this ref before writing results. Stale (older) calls are
   *  discarded so fast typing can't race an older result over a newer one. */
  let searchSeq = 0;

  const toUser = (u: { address: string; name: string; image?: string }): User => ({
    address: u.address,
    name: u.name || u.address,
    about: "",
    image: u.image ?? "",
    site: "",
    language: "",
  });

  const searchUsers = async (query: string) => {
    const trimmed = query.trim();
    const mySeq = ++searchSeq;
    /** Only the latest call is allowed to mutate shared refs. */
    const isLatest = () => mySeq === searchSeq;

    if (!trimmed) {
      if (!isLatest()) return;
      searchResults.value = [];
      searchError.value = null;
      return;
    }

    const myAddress = authStore.address ?? "";
    if (isLatest()) {
      searchError.value = null;
      isSearching.value = true;
    }

    try {
      // 1) Dexie TTL cache — instant re-display for a recently-seen query.
      let cached: CachedSearchUser[] = [];
      if (isChatDbReady()) {
        try {
          const row = await getChatDb().searchCache.get(trimmed);
          cached = row ?? [];
        } catch {
          cached = [];
        }
      }
      // Show cached results immediately so the user sees *something* while the
      // background tiers finish. These will be merged with tier 2/3/4 below.
      if (cached.length > 0 && isLatest()) {
        searchResults.value = cached
          .filter(u => u.address !== myAddress)
          .map(toUser);
      }

      // 2) Bastyon RPC — canonical Pocketnet search. On web this may fail with
      //    CORS; we still fall through to Matrix user_directory below.
      let rpcResults: Array<{ address: string; name: string; image: string }> = [];
      try {
        rpcResults = await getAppInit().searchUsers(trimmed);
      } catch (rpcErr) {
        console.warn("[useContacts] Bastyon RPC searchUsers failed, falling back:", rpcErr);
      }

      // 3) Matrix user_directory fallback — works whenever Matrix is online.
      let matrixResults: Array<{ address: string; name: string; image: string }> = [];
      const matrixService = getMatrixClientService();
      if (matrixService.isReady()) {
        try {
          const resp = await matrixService.searchUserDirectory(trimmed, 20);
          matrixResults = resp.results
            .map(normalizeMatrixDirectoryUser)
            .filter((u): u is { address: string; name: string; image: string } => u !== null);
        } catch (mErr) {
          console.warn("[useContacts] Matrix user_directory fallback failed:", mErr);
        }
      }

      // If a newer searchUsers() has started while we were awaiting RPC/Matrix,
      // bail out without touching shared refs — its results will replace ours.
      if (!isLatest()) return;

      // 4) Local user store — previously-seen users (case-insensitive match on
      //    name or address). Matches the original fallback behaviour.
      const q = trimmed.toLowerCase();
      const localResults = Object.values(userStore.users)
        .filter(u =>
          u.address !== myAddress &&
          ((u.name ?? "").toLowerCase().includes(q) ||
           u.address.toLowerCase().includes(q))
        )
        .map(u => ({ address: u.address, name: u.name || u.address, image: u.image ?? "" }));

      // 5) Merge, dedupe by address, filter self. Fresh tiers win over cached
      //    (cache last) so renames/avatar updates from a new RPC call land.
      const merged = dedupeByAddress([...rpcResults, ...matrixResults, ...localResults, ...cached.map(c => ({ address: c.address, name: c.name, image: c.image ?? "" }))])
        .filter(u => u.address && u.address !== myAddress);

      searchResults.value = merged.map(toUser);

      // Cache found users in user store so subsequent local lookups succeed.
      for (const user of searchResults.value) {
        userStore.setUser(user.address, user);
      }

      // Persist to Dexie cache for 1h TTL reuse.
      if (isChatDbReady() && merged.length > 0) {
        try {
          await getChatDb().searchCache.put(
            trimmed,
            merged.map(u => ({ address: u.address, name: u.name, image: u.image })),
          );
        } catch {
          // cache write failure is non-fatal
        }
      }

      if (searchResults.value.length === 0) {
        // If all three tiers returned nothing, surface a localizable "not found"
        // signal instead of whatever raw string the SDK may have produced.
        searchError.value = "search.userNotFound";
      }
    } catch (e) {
      console.error("[useContacts] searchUsers failed:", e);
      if (!isLatest()) return;
      // Last-resort: serve cached user-store matches and surface a service-unavailable key.
      const q = trimmed.toLowerCase();
      const localMatches = Object.values(userStore.users)
        .filter(user =>
          user.address !== myAddress &&
          ((user.name ?? "").toLowerCase().includes(q) ||
           user.address.toLowerCase().includes(q))
        );
      searchResults.value = localMatches;
      // Always surface the remote failure as a service-unavailable signal —
      // local matches alone don't indicate the remote search succeeded.
      searchError.value = "search.serviceUnavailable";
    } finally {
      if (isLatest()) isSearching.value = false;
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
    searchError,
    searchUsers,
    debouncedSearch,
    getOrCreateRoom,
  };
}
