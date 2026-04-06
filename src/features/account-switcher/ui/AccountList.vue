<script setup lang="ts">
import { useAuthStore } from "@/entities/auth";
import { useUserStore } from "@/entities/user/model";
import Avatar from "@/shared/ui/avatar/Avatar.vue";

const props = withDefaults(
  defineProps<{
    compact?: boolean;
    showActive?: boolean;
  }>(),
  {
    compact: false,
    showActive: true,
  },
);

const emit = defineEmits<{
  switch: [address: string];
  add: [];
  remove: [address: string];
}>();

const { t } = useI18n();
const authStore = useAuthStore();
const userStore = useUserStore();

// Eagerly load profiles for all sessions (shallow: only react to address list changes)
watch(
  () => authStore.sessions.map((s) => s.address),
  (addresses) => {
    for (const addr of addresses) {
      userStore.loadUserIfMissing(addr);
    }
  },
  { immediate: true },
);

const visibleAccounts = computed(() => {
  if (props.showActive) return authStore.sessions;
  return authStore.sessions.filter((s) => s.address !== authStore.activeAddress);
});

function getUnreadCount(address: string): number {
  return authStore.getBackgroundUnreadCount(address);
}

function formatUnread(count: number): string {
  return count > 99 ? "99+" : String(count);
}
</script>

<template>
  <div class="flex flex-col">
    <!-- Account items -->
    <div
      v-for="account in visibleAccounts"
      :key="account.address"
      class="group flex w-full items-center rounded-lg transition-colors hover:bg-neutral-grad-0"
      :class="compact ? 'px-2 py-2' : 'px-3 py-3'"
    >
      <button
        class="flex min-w-0 flex-1 items-center gap-3"
        @click="emit('switch', account.address)"
      >
        <!-- Avatar with active dot -->
        <div class="relative shrink-0">
          <Avatar
            :src="userStore.getUser(account.address)?.image"
            :name="
              userStore.getUser(account.address)?.name ||
              account.address
            "
            :size="compact ? 'sm' : 'md'"
          />
          <!-- Green active dot -->
          <span
            v-if="account.address === authStore.activeAddress"
            class="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-chat-sidebar bg-color-good"
          />
        </div>

        <!-- Name + address -->
        <div class="flex min-w-0 flex-1 flex-col text-left">
          <span
            class="truncate text-sm font-medium text-text-color"
            :class="compact ? 'text-xs' : 'text-sm'"
          >
            {{
              userStore.getUser(account.address)?.name ||
              account.address
            }}
          </span>
          <span
            v-if="!compact"
            class="truncate text-xs text-text-on-main-bg-color"
          >
            {{ account.address }}
          </span>
        </div>

        <!-- Checkmark for active account -->
        <svg
          v-if="account.address === authStore.activeAddress"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="shrink-0 text-color-bg-ac"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>

        <!-- Unread badge for non-active accounts -->
        <span
          v-else-if="getUnreadCount(account.address) > 0"
          class="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-color-bg-ac px-1.5 text-[11px] font-medium leading-none text-white"
        >
          {{ formatUnread(getUnreadCount(account.address)) }}
        </span>
      </button>

      <!-- Remove button (visible on hover / always on touch) -->
      <button
        v-if="!compact && account.address !== authStore.activeAddress"
        class="ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-text-on-main-bg-color opacity-0 transition-opacity hover:bg-neutral-grad-0 hover:text-color-bad group-hover:opacity-100"
        :aria-label="t('settings.removeAccount')"
        @click.stop="emit('remove', account.address)"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>

    <!-- Add account button -->
    <button
      v-if="!compact"
      class="flex w-full items-center gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-neutral-grad-0"
      @click="emit('add')"
    >
      <div
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 border-dashed border-text-on-main-bg-color/40"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="text-text-on-main-bg-color"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </div>
      <span class="text-sm text-text-on-main-bg-color">{{
        t("settings.addAccount")
      }}</span>
    </button>
  </div>
</template>
