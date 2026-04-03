<script setup lang="ts">
import type { SidebarTab } from "../model/use-sidebar-tab";
import { useChatStore } from "@/entities/chat";
import { useAuthStore } from "@/entities/auth";
import { useUserStore } from "@/entities/user/model";
import Avatar from "@/shared/ui/avatar/Avatar.vue";

const props = defineProps<{ modelValue: SidebarTab }>();
const emit = defineEmits<{ "update:modelValue": [tab: SidebarTab] }>();

const { t } = useI18n();
const chatStore = useChatStore();
const authStore = useAuthStore();
const userStore = useUserStore();

// Eagerly load current user's profile (no lazy loading for always-visible tab icon)
watch(
  () => authStore.address,
  (addr) => { if (addr) userStore.loadUserIfMissing(addr); },
  { immediate: true },
);

const currentUser = computed(() =>
  authStore.address ? userStore.getUser(authStore.address) : undefined,
);


</script>

<template>
  <nav
    aria-label="Main navigation"
    class="flex h-14 shrink-0 border-t border-neutral-grad-0 bg-chat-sidebar box-content"
    style="padding-bottom: var(--safe-area-inset-bottom, 0px)"
  >
    <!-- Contacts -->
    <button
      class="btn-press relative flex flex-1 flex-col items-center justify-center gap-0.5"
      :class="modelValue === 'contacts' ? 'text-color-bg-ac' : 'text-text-on-main-bg-color'"
      :aria-label="t('nav.contacts')"
      :aria-current="modelValue === 'contacts' ? 'page' : undefined"
      @click="emit('update:modelValue', 'contacts')"
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
      <span class="text-[10px] leading-tight">{{ t("nav.contacts") }}</span>
    </button>

    <!-- Chats -->
    <button
      class="btn-press relative flex flex-1 flex-col items-center justify-center gap-0.5"
      :class="modelValue === 'chats' ? 'text-color-bg-ac' : 'text-text-on-main-bg-color'"
      :aria-label="t('nav.chats') + (chatStore.totalUnread > 0 ? ` (${chatStore.totalUnread})` : '')"
      :aria-current="modelValue === 'chats' ? 'page' : undefined"
      @click="emit('update:modelValue', 'chats')"
    >
      <div class="relative">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <!-- Unread badge -->
        <span
          v-if="chatStore.totalUnread > 0"
          class="absolute -right-2.5 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-color-bg-ac px-1 text-[10px] font-medium leading-none text-white"
        >
          {{ chatStore.totalUnread > 99 ? "99+" : chatStore.totalUnread }}
        </span>
      </div>
      <span class="text-[10px] leading-tight">{{ t("nav.chats") }}</span>
    </button>

    <!-- Settings -->
    <button
      class="btn-press relative flex flex-1 flex-col items-center justify-center gap-0.5"
      :class="modelValue === 'settings' ? 'text-color-bg-ac' : 'text-text-on-main-bg-color'"
      :aria-label="t('nav.settings')"
      :aria-current="modelValue === 'settings' ? 'page' : undefined"
      @click="emit('update:modelValue', 'settings')"
    >
      <div
        v-if="authStore.address"
        class="avatar-tab-icon"
        :class="modelValue === 'settings' ? 'ring-2 ring-color-bg-ac' : ''"
      >
        <Avatar
          :src="currentUser?.image"
          :name="currentUser?.name || authStore.address"
          size="sm"
        />
      </div>
      <svg
        v-else
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <circle cx="12" cy="12" r="3" />
        <path
          d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
        />
      </svg>
      <span class="text-[10px] leading-tight">{{ t("nav.settings") }}</span>
    </button>

  </nav>
</template>

<style scoped>
.avatar-tab-icon {
  width: 24px;
  height: 24px;
  border-radius: 9999px;
  overflow: hidden;
  flex-shrink: 0;
}

.avatar-tab-icon :deep(> div) {
  width: 24px;
  height: 24px;
}

.avatar-tab-icon :deep(img),
.avatar-tab-icon :deep(.rounded-full) {
  width: 24px !important;
  height: 24px !important;
}
</style>
