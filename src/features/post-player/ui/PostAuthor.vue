<script setup lang="ts">
interface Props {
  name: string;
  avatarUrl: string;
  address: string;
  time?: number;
}

const props = defineProps<Props>();

const formattedTime = computed(() => {
  if (!props.time) return "";
  return new Date(props.time * 1000).toLocaleDateString();
});
</script>

<template>
  <div class="flex items-center gap-2.5">
    <img
      v-if="avatarUrl"
      :src="avatarUrl"
      alt=""
      class="h-8 w-8 rounded-full object-cover"
    />
    <div
      v-else
      class="flex h-8 w-8 items-center justify-center rounded-full bg-color-bg-ac/20 text-sm font-bold text-color-bg-ac"
    >
      {{ name.charAt(0).toUpperCase() }}
    </div>
    <div class="flex flex-col">
      <span class="text-sm font-medium text-text-color">{{ name }}</span>
      <span v-if="formattedTime" class="text-xs text-text-on-main-bg-color">{{ formattedTime }}</span>
    </div>
  </div>
</template>
