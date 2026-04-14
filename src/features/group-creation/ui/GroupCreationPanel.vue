<script setup lang="ts">
import { nextTick } from "vue";
import { UserAvatar } from "@/entities/user";
import Avatar from "@/shared/ui/avatar/Avatar.vue";
import { useGroupCreation } from "../model/use-group-creation";

const { t } = useI18n();

const emit = defineEmits<{ created: [roomId: string]; close: [] }>();

const {
  step,
  selectedMembers,
  selectedMembersList,
  groupName,
  groupAvatarPreview,
  isCreating,
  error,
  searchQuery,
  searchResults,
  isSearching,
  debouncedSearch,
  toggleMember,
  isMemberSelected,
  removeMember,
  setAvatarFile,
  goToStep2,
  goToStep1,
  createGroup,
  reset,
} = useGroupCreation();

const nameInput = ref<HTMLInputElement>();
const fileInput = ref<HTMLInputElement>();

const handleSearch = (e: Event) => {
  const value = (e.target as HTMLInputElement).value;
  searchQuery.value = value;
  debouncedSearch(value);
};

const handleNext = () => {
  goToStep2();
  nextTick(() => nameInput.value?.focus());
};

const handleBack = () => {
  if (step.value === 2) {
    goToStep1();
  } else {
    handleClose();
  }
};

const handleCreate = async () => {
  const roomId = await createGroup();
  if (roomId) {
    reset();
    emit("created", roomId);
  }
};

const handleClose = () => {
  reset();
  emit("close");
};

const handleAvatarClick = () => {
  fileInput.value?.click();
};

const handleAvatarChange = (e: Event) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) setAvatarFile(file);
};
</script>

<template>
  <div class="flex h-full flex-col bg-background-total-theme">
    <!-- Step 1: Select Members -->
    <template v-if="step === 1">
      <!-- Header -->
      <div class="flex h-14 shrink-0 items-center gap-3 border-b border-neutral-grad-0 px-3">
        <button
          class="flex h-9 w-9 items-center justify-center rounded-full text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
          @click="handleBack"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M19 12H5" /><path d="M12 19l-7-7 7-7" />
          </svg>
        </button>

        <span class="flex-1 text-base font-semibold text-text-color">New Group</span>

        <button
          class="rounded-lg px-4 py-1.5 text-sm font-medium transition-colors"
          :class="selectedMembers.size > 0
            ? 'bg-color-bg-ac text-white hover:bg-color-bg-ac-1'
            : 'bg-neutral-grad-0 text-text-on-main-bg-color opacity-50 cursor-not-allowed'"
          :disabled="selectedMembers.size === 0"
          @click="handleNext"
        >
          Next
        </button>
      </div>

      <!-- Selected members chips -->
      <div v-if="selectedMembersList.length > 0" class="flex shrink-0 gap-2 overflow-x-auto border-b border-neutral-grad-0 px-3 py-2">
        <div
          v-for="member in selectedMembersList"
          :key="member.address"
          class="flex shrink-0 items-center gap-1.5 rounded-full bg-neutral-grad-0 py-1 pl-1 pr-2.5"
        >
          <UserAvatar :address="member.address" size="sm" />
          <span class="max-w-[80px] truncate text-xs text-text-color">{{ member.name }}</span>
          <button
            class="flex h-4 w-4 items-center justify-center rounded-full text-text-on-main-bg-color hover:text-text-color"
            @click="removeMember(member.address)"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      <!-- Search input -->
      <div class="shrink-0 border-b border-neutral-grad-0 px-3 py-2">
        <input
          :value="searchQuery"
          type="text"
          :placeholder="t('group.searchUsers')"
          class="w-full rounded-lg bg-chat-input-bg px-3 py-2 text-sm text-text-color outline-none placeholder:text-neutral-grad-2"
          @input="handleSearch"
        />
      </div>

      <!-- User list -->
      <div class="flex-1 overflow-y-auto">
        <div v-if="isSearching" class="flex items-center justify-center p-8">
          <div class="h-6 w-6 shrink-0 contain-strict animate-spin rounded-full border-2 border-color-bg-ac border-t-transparent" />
        </div>

        <div v-else-if="searchResults.length === 0 && searchQuery" class="p-8 text-center text-sm text-text-on-main-bg-color">
          No users found
        </div>

        <div v-else-if="searchResults.length === 0 && !searchQuery" class="p-8 text-center text-sm text-text-on-main-bg-color">
          Search for users to add to the group
        </div>

        <button
          v-for="user in searchResults"
          :key="user.address"
          class="flex w-full items-center gap-3 px-3 py-2.5 transition-colors hover:bg-neutral-grad-0"
          @click="toggleMember({ address: user.address, name: user.name, image: user.image })"
        >
          <!-- Checkbox -->
          <div
            class="flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 transition-colors"
            :class="isMemberSelected(user.address) ? 'border-color-bg-ac bg-color-bg-ac' : 'border-neutral-grad-2'"
          >
            <svg v-if="isMemberSelected(user.address)" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>

          <UserAvatar :address="user.address" size="sm" />

          <div class="min-w-0 flex-1 text-left">
            <div class="truncate text-sm font-medium text-text-color">{{ user.name }}</div>
            <div class="truncate text-xs text-text-on-main-bg-color">{{ user.address }}</div>
          </div>
        </button>
      </div>
    </template>

    <!-- Step 2: Name & Avatar -->
    <template v-else>
      <!-- Header -->
      <div class="flex h-14 shrink-0 items-center gap-3 border-b border-neutral-grad-0 px-3">
        <button
          class="flex h-9 w-9 items-center justify-center rounded-full text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
          @click="goToStep1"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M19 12H5" /><path d="M12 19l-7-7 7-7" />
          </svg>
        </button>

        <span class="flex-1 text-base font-semibold text-text-color">New Group</span>

        <button
          class="rounded-lg px-4 py-1.5 text-sm font-medium transition-colors"
          :class="groupName.trim() && !isCreating
            ? 'bg-color-bg-ac text-white hover:bg-color-bg-ac-1'
            : 'bg-neutral-grad-0 text-text-on-main-bg-color opacity-50 cursor-not-allowed'"
          :disabled="!groupName.trim() || isCreating"
          @click="handleCreate"
        >
          {{ isCreating ? "Creating..." : "Create" }}
        </button>
      </div>

      <div class="flex-1 overflow-y-auto">
        <!-- Avatar + Name section -->
        <div class="flex items-center gap-4 p-4">
          <!-- Avatar picker -->
          <div class="relative shrink-0 cursor-pointer" @click="handleAvatarClick">
            <div
              v-if="groupAvatarPreview"
              class="flex h-16 w-16 items-center justify-center overflow-hidden rounded-full"
            >
              <img :src="groupAvatarPreview" class="h-full w-full object-cover" />
            </div>
            <div
              v-else
              class="flex h-16 w-16 items-center justify-center rounded-full bg-color-bg-ac"
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2">
                <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
            </div>
            <input
              ref="fileInput"
              type="file"
              accept="image/*"
              class="hidden"
              @change="handleAvatarChange"
            />
          </div>

          <!-- Group name input -->
          <input
            ref="nameInput"
            v-model="groupName"
            type="text"
            :placeholder="t('group.groupName')"
            class="flex-1 border-b border-neutral-grad-0 bg-transparent py-2 text-base text-text-color outline-none placeholder:text-neutral-grad-2 focus:border-color-bg-ac"
          />
        </div>

        <!-- Error -->
        <div v-if="error" class="px-4 pb-2 text-sm text-color-bad">
          {{ error }}
        </div>

        <!-- Member count -->
        <div class="px-4 pb-2 text-sm text-text-on-main-bg-color">
          {{ selectedMembers.size }} member{{ selectedMembers.size !== 1 ? "s" : "" }}
        </div>

        <!-- Member preview list -->
        <div class="px-4">
          <div
            v-for="member in selectedMembersList"
            :key="member.address"
            class="flex items-center gap-3 py-2"
          >
            <UserAvatar :address="member.address" size="sm" />
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm text-text-color">{{ member.name }}</div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
