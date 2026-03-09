<script setup lang="ts">
import ChatSidebar from "@/widgets/sidebar/ChatSidebar.vue";
import ChatWindow from "@/widgets/chat-window/ChatWindow.vue";
import SettingsContentPanel from "@/widgets/sidebar/ui/SettingsContentPanel.vue";
import { GroupCreationPanel } from "@/features/group-creation";
import { useChatStore } from "@/entities/chat";
import { useAuthStore } from "@/entities/auth";
import { useI18n } from "@/shared/lib/i18n";
import { useSidebarTab } from "@/widgets/sidebar/model/use-sidebar-tab";

const chatStore = useChatStore();
const authStore = useAuthStore();
const { t } = useI18n();
const { settingsSubView, closeSettingsContent, setTab } = useSidebarTab();

const showSidebar = ref(true);
const isMobile = ref(false);

let resizeTimer: ReturnType<typeof setTimeout> | undefined;
const checkMobile = () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    isMobile.value = window.innerWidth < 768;
  }, 150);
};

onMounted(() => {
  isMobile.value = window.innerWidth < 768;
  window.addEventListener("resize", checkMobile);
});

onUnmounted(() => {
  window.removeEventListener("resize", checkMobile);
  clearTimeout(resizeTimer);
});

const onSelectRoom = () => {
  // Close settings/profile panels so ChatWindow is visible
  closeSettingsContent();
  setTab("chats");
  if (isMobile.value) {
    showSidebar.value = false;
  }
};

const onBackToSidebar = () => {
  chatStore.setActiveRoom(null);
  showSidebar.value = true;
};

const showGroupCreation = ref(false);

const onNewGroup = () => {
  showGroupCreation.value = true;
};

const onGroupCreated = () => {
  showGroupCreation.value = false;
  if (isMobile.value) showSidebar.value = false;
};

const onCloseGroupCreation = () => {
  showGroupCreation.value = false;
};
</script>

<template>
  <div class="relative flex h-full bg-background-total-theme" :class="{ 'overflow-hidden': isMobile }">
    <!-- Registration pending overlay — blocks chat while blockchain confirms -->
    <transition name="fade">
      <div
        v-if="authStore.registrationPending"
        class="absolute inset-0 z-[998] flex items-center justify-center bg-background-total-theme"
      >
        <div class="flex flex-col items-center gap-4 p-8 text-center">
          <Spinner size="lg" />
          <h2 class="text-xl font-bold text-text-color">{{ t("register.accountPending") }}</h2>
          <p class="max-w-sm text-sm text-text-on-main-bg-color">
            {{ t("register.accountPendingDescription") }}
          </p>
          <p class="text-xs text-text-on-main-bg-color">
            {{ t("register.accountPendingHint") }}
          </p>
        </div>
      </div>
    </transition>

    <!-- Desktop: show both side by side -->
    <template v-if="!isMobile">
      <ChatSidebar
        class="h-full w-80 shrink-0"
        @select-room="onSelectRoom"
        @new-group="onNewGroup"
      />
      <GroupCreationPanel
        v-if="showGroupCreation"
        class="h-full flex-1"
        @created="onGroupCreated"
        @close="onCloseGroupCreation"
      />
      <SettingsContentPanel
        v-else-if="settingsSubView"
        class="h-full flex-1"
      />
      <ChatWindow
        v-else
        class="h-full flex-1"
        @back="onBackToSidebar"
      />
    </template>

    <!-- Mobile: slide transitions between sidebar and chat -->
    <template v-else>
      <transition name="slide-left">
        <ChatSidebar
          v-show="showSidebar && !showGroupCreation && !settingsSubView"
          class="absolute inset-0 z-10 h-full w-full"
          @select-room="onSelectRoom"
          @new-group="onNewGroup"
        />
      </transition>
      <transition name="slide-right">
        <ChatWindow
          v-show="!showSidebar && !showGroupCreation && !settingsSubView"
          class="absolute inset-0 z-10 h-full w-full"
          @back="onBackToSidebar"
        />
      </transition>
      <transition name="slide-right">
        <SettingsContentPanel
          v-if="settingsSubView"
          class="absolute inset-0 z-[15] h-full w-full"
        />
      </transition>
      <transition name="slide-right">
        <GroupCreationPanel
          v-if="showGroupCreation"
          class="absolute inset-0 z-20 h-full w-full"
          @created="onGroupCreated"
          @close="onCloseGroupCreation"
        />
      </transition>
    </template>
  </div>
</template>

<style scoped>
/* Sidebar slides out to left when hiding */
.slide-left-leave-active {
  transition: transform 0.25s ease-in;
}
.slide-left-leave-to {
  transform: translateX(-30%);
}
.slide-left-enter-active {
  transition: transform 0.25s ease-out;
}
.slide-left-enter-from {
  transform: translateX(-30%);
}

/* Chat window / group creation slides in from right */
.slide-right-enter-active {
  transition: transform 0.25s ease-out;
}
.slide-right-enter-from {
  transform: translateX(100%);
}
.slide-right-leave-active {
  transition: transform 0.25s ease-in;
}
.slide-right-leave-to {
  transform: translateX(100%);
}

@media (prefers-reduced-motion: reduce) {
  .slide-left-enter-active,
  .slide-left-leave-active,
  .slide-right-enter-active,
  .slide-right-leave-active {
    transition: none;
  }
}
</style>
