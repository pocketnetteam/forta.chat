import { defineStore } from "pinia";
import { ref } from "vue";

const NAMESPACE = "media";

export const useMediaStore = defineStore(NAMESPACE, () => {
  const selectedAudioDevice = ref<string | null>(null);
  const selectedVideoDevice = ref<string | null>(null);

  return {
    selectedAudioDevice,
    selectedVideoDevice,
  };
});
