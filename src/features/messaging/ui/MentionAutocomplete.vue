<script setup lang="ts">
import { watch, ref, nextTick } from "vue";
import { useChatStore } from "@/entities/chat";
import { UserAvatar } from "@/entities/user";
import { hexDecode } from "@/shared/lib/matrix/functions";

interface Props {
  members: string[]; // filtered hex IDs
  selectedIndex: number;
}

const props = defineProps<Props>();
const emit = defineEmits<{ select: [hexId: string] }>();

const chatStore = useChatStore();
const listRef = ref<HTMLElement>();

// Auto-scroll selected item into view
watch(() => props.selectedIndex, () => {
  nextTick(() => {
    const el = listRef.value;
    if (!el) return;
    const selected = el.children[props.selectedIndex] as HTMLElement | undefined;
    selected?.scrollIntoView({ block: "nearest" });
  });
});
</script>

<template>
  <div
    class="absolute bottom-full left-0 right-0 z-50 mb-1 overflow-hidden rounded-xl border border-neutral-grad-0 bg-background-total-theme shadow-lg"
  >
    <div ref="listRef" class="max-h-[200px] overflow-y-auto py-1">
      <button
        v-for="(member, i) in props.members"
        :key="member"
        class="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors"
        :class="i === props.selectedIndex ? 'bg-color-bg-ac/10' : 'hover:bg-neutral-grad-0/50'"
        @mousedown.prevent="emit('select', member)"
      >
        <UserAvatar :address="hexDecode(member)" size="sm" />
        <span class="truncate text-sm text-text-color">
          {{ chatStore.getDisplayName(member) }}
        </span>
      </button>
    </div>
  </div>
</template>
