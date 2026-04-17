<script setup lang="ts">
const props = withDefaults(defineProps<{ firstLoad?: boolean }>(), { firstLoad: false });
const { t } = useI18n();
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Full loading message — only on first login (no cache) -->
    <div v-if="props.firstLoad" class="flex flex-col items-center gap-2 px-4 pt-8 pb-4 text-center">
      <div class="contain-strict h-5 w-5 animate-spin rounded-full border-2 border-neutral-grad-2 border-t-primary" />
      <p class="text-sm font-medium text-neutral-content">{{ t('contactList.loadingChats') }}</p>
      <p class="text-xs text-neutral-content/60">{{ t('contactList.loadingChatsHint') }}</p>
    </div>

    <!-- Skeleton rows -->
    <div class="space-y-1">
      <div v-for="i in 6" :key="i" class="flex items-center gap-3 px-3 py-2.5">
        <div class="h-10 w-10 shrink-0 animate-pulse rounded-full bg-neutral-grad-2" />
        <div class="min-w-0 flex-1 space-y-1.5">
          <div class="h-3.5 w-24 animate-pulse rounded bg-neutral-grad-2" />
          <div
            class="h-3 animate-pulse rounded bg-neutral-grad-2"
            :style="{ width: `${100 + (i * 29) % 80}px` }"
          />
        </div>
        <div class="h-3 w-8 animate-pulse rounded bg-neutral-grad-2" />
      </div>
    </div>
  </div>
</template>
