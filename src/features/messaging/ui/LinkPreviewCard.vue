<script setup lang="ts">
import { computed, ref } from "vue";
import type { LinkPreview } from "@/entities/chat";

const props = defineProps<{
  preview: LinkPreview;
  isOwn: boolean;
}>();

const openUrl = () => {
  // Only allow http/https URLs to prevent javascript: XSS
  if (/^https?:\/\//i.test(props.preview.url)) {
    window.open(props.preview.url, "_blank", "noopener,noreferrer");
  }
};

const siteName = computed(() => {
  if (props.preview.siteName) return props.preview.siteName;
  try {
    return new URL(props.preview.url).hostname;
  } catch {
    return props.preview.url;
  }
});

const imageError = ref(false);
</script>

<template>
  <div
    class="mt-1.5 cursor-pointer overflow-hidden rounded-lg border-l-2 border-color-bg-ac"
    :class="props.isOwn ? 'bg-white/10' : 'bg-black/5'"
    @click.stop="openUrl"
  >
    <div class="px-2.5 py-1.5">
      <div class="truncate text-xs font-medium" :class="props.isOwn ? 'text-white/70' : 'text-color-bg-ac'">
        {{ siteName }}
      </div>
      <div v-if="preview.title" class="mt-0.5 line-clamp-2 text-sm font-semibold leading-tight"
        :class="props.isOwn ? 'text-white/90' : 'text-text-color'">
        {{ preview.title }}
      </div>
      <div v-if="preview.description" class="mt-0.5 line-clamp-3 text-xs leading-relaxed"
        :class="props.isOwn ? 'text-white/60' : 'text-text-on-main-bg-color'">
        {{ preview.description }}
      </div>
    </div>
    <img
      v-if="preview.imageUrl && !imageError"
      :src="preview.imageUrl"
      :alt="preview.title || ''"
      class="block max-h-[200px] w-full object-cover"
      loading="lazy"
      @error="imageError = true"
    />
  </div>
</template>
