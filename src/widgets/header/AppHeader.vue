<script setup lang="ts">
import { useAuthStore } from "@/entities/auth";
import { useSidebarTab } from "@/widgets/sidebar/model/use-sidebar-tab";

const router = useRouter();
const authStore = useAuthStore();
const { setTab } = useSidebarTab();

const navigate = (name: string) => {
  router.push({ name });
};
</script>

<template>
  <header
    class="flex h-14 shrink-0 items-center justify-between border-b border-neutral-grad-0 bg-background-total-theme px-4"
  >
    <div class="flex items-center gap-3">
      <span class="text-lg font-bold text-text-color"></span>
    </div>

    <nav class="flex items-center gap-2">
      <button
        class="rounded-lg px-3 py-1.5 text-sm text-text-on-main-bg-color hover:bg-neutral-grad-0"
        @click="navigate('ChatPage')"
      >
        Chat
      </button>
      <button
        class="rounded-lg px-3 py-1.5 text-sm text-text-on-main-bg-color hover:bg-neutral-grad-0"
        @click="navigate('ProfilePage')"
      >
        Profile
      </button>
      <button
        class="rounded-lg px-3 py-1.5 text-sm text-text-on-main-bg-color hover:bg-neutral-grad-0"
        @click="navigate('ChatPage'); setTab('settings')"
      >
        Settings
      </button>
      <button
        class="rounded-lg px-3 py-1.5 text-sm text-color-bad hover:bg-neutral-grad-0"
        @click="
          authStore.logout();
          navigate('WelcomePage');
        "
      >
        Logout
      </button>
    </nav>
  </header>
</template>
