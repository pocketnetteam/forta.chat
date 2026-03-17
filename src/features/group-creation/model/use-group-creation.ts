import { ref, computed } from "vue";
import { useContacts } from "@/features/contacts/model/use-contacts";
import { useChatStore } from "@/entities/chat";
import { getMatrixClientService } from "@/entities/matrix";
import { hexEncode } from "@/shared/lib/matrix/functions";
import { MATRIX_SERVER } from "@/shared/config";

export interface SelectedMember {
  address: string;
  name: string;
  image: string;
}

export function useGroupCreation() {
  const chatStore = useChatStore();
  const { searchQuery, searchResults, isSearching, debouncedSearch } = useContacts();

  // Wizard state
  const step = ref<1 | 2>(1);
  const selectedMembers = ref<Map<string, SelectedMember>>(new Map());
  const groupName = ref("");
  const groupAvatarFile = ref<File | null>(null);
  const groupAvatarPreview = ref<string | null>(null);
  const isCreating = ref(false);
  const error = ref<string | null>(null);

  const selectedMembersList = computed(() => [...selectedMembers.value.values()]);

  const toggleMember = (user: { address: string; name: string; image: string }) => {
    const map = new Map(selectedMembers.value);
    if (map.has(user.address)) {
      map.delete(user.address);
    } else {
      map.set(user.address, { address: user.address, name: user.name, image: user.image });
    }
    selectedMembers.value = map;
  };

  const isMemberSelected = (address: string): boolean => {
    return selectedMembers.value.has(address);
  };

  const removeMember = (address: string) => {
    const map = new Map(selectedMembers.value);
    map.delete(address);
    selectedMembers.value = map;
  };

  const setAvatarFile = (file: File) => {
    groupAvatarFile.value = file;
    groupAvatarPreview.value = URL.createObjectURL(file);
  };

  const goToStep2 = () => {
    if (selectedMembers.value.size < 1) return;
    step.value = 2;
  };

  const goToStep1 = () => {
    step.value = 1;
  };

  const createGroup = async (): Promise<string | null> => {
    if (!groupName.value.trim() || selectedMembers.value.size < 1) return null;

    isCreating.value = true;
    error.value = null;

    try {
      const matrixService = getMatrixClientService();

      // Build Matrix IDs for all selected members
      const inviteIds = [...selectedMembers.value.values()].map(
        (m) => `@${hexEncode(m.address).toLowerCase()}:${MATRIX_SERVER}`,
      );

      // Upload avatar if provided
      let mxcUrl: string | undefined;
      if (groupAvatarFile.value) {
        mxcUrl = await matrixService.uploadContentMxc(groupAvatarFile.value);
      }

      // Build initial_state
      const initialState: Record<string, unknown>[] = [
        {
          type: "m.set.encrypted",
          state_key: "",
          content: { encrypted: true },
        },
      ];
      if (mxcUrl) {
        initialState.push({
          type: "m.room.avatar",
          state_key: "",
          content: { url: mxcUrl },
        });
      }

      // Create the room
      const result = await matrixService.createRoom({
        name: groupName.value.trim(),
        visibility: "private",
        invite: inviteIds,
        initial_state: initialState,
        power_level_content_override: {
          users: { [matrixService.getUserId() ?? ""]: 100 },
          users_default: 0,
          events_default: 0,
          state_default: 50,
          kick: 50,
          ban: 50,
          invite: 0,
          redact: 50,
        },
      });

      const roomId = result.room_id;

      // Add room to local store
      const memberHexIds = [...selectedMembers.value.values()].map(
        (m) => hexEncode(m.address).toLowerCase(),
      );
      const myUserId = matrixService.getUserId() ?? "";
      const myHexId = myUserId.split(":")[0]?.replace("@", "") ?? "";

      // Convert mxc:// to HTTP for display
      const avatarHttp = mxcUrl ? matrixService.mxcToHttp(mxcUrl) ?? undefined : undefined;

      chatStore.addRoom({
        id: roomId,
        name: groupName.value.trim(),
        avatar: avatarHttp,
        unreadCount: 0,
        members: [myHexId, ...memberHexIds],
        isGroup: true,
        updatedAt: Date.now(),
      });

      chatStore.setActiveRoom(roomId);
      chatStore.refreshRooms();

      return roomId;
    } catch (e) {
      console.error("[useGroupCreation] createGroup error:", e);
      error.value = String(e);
      return null;
    } finally {
      isCreating.value = false;
    }
  };

  const reset = () => {
    step.value = 1;
    selectedMembers.value = new Map();
    groupName.value = "";
    if (groupAvatarPreview.value) {
      URL.revokeObjectURL(groupAvatarPreview.value);
    }
    groupAvatarFile.value = null;
    groupAvatarPreview.value = null;
    isCreating.value = false;
    error.value = null;
    searchQuery.value = "";
  };

  return {
    // State
    step,
    selectedMembers,
    selectedMembersList,
    groupName,
    groupAvatarFile,
    groupAvatarPreview,
    isCreating,
    error,
    // Search (from useContacts)
    searchQuery,
    searchResults,
    isSearching,
    debouncedSearch,
    // Methods
    toggleMember,
    isMemberSelected,
    removeMember,
    setAvatarFile,
    goToStep2,
    goToStep1,
    createGroup,
    reset,
  };
}
