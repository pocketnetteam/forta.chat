import { ref } from "vue";

export type SidebarTab = "contacts" | "chats" | "settings";
export type SettingsSubView = "profile" | "appearance" | "about" | null;

const activeTab = ref<SidebarTab>("chats");
const settingsSubView = ref<SettingsSubView>(null);

export function useSidebarTab() {
  const setTab = (tab: SidebarTab) => {
    activeTab.value = tab;
    // Clear sub-view when leaving settings
    if (tab !== "settings") settingsSubView.value = null;
  };

  const openSettingsContent = (view: "profile" | "appearance" | "about") => {
    settingsSubView.value = view;
  };

  const closeSettingsContent = () => {
    settingsSubView.value = null;
  };

  return { activeTab, setTab, settingsSubView, openSettingsContent, closeSettingsContent };
}
