<script setup lang="ts">
import { computed, onUnmounted, ref } from "vue";
import type { Message } from "@/entities/chat";

interface Props {
  message: Message;
  isOwn: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  vote: [optionId: string];
  end: [];
}>();

const poll = computed(() => props.message.pollInfo!);

const totalVotes = computed(() => {
  let total = 0;
  for (const voters of Object.values(poll.value.votes)) {
    total += voters.length;
  }
  return total;
});

const hasVoted = computed(() => !!poll.value.myVote);

const getVoteCount = (optionId: string): number => {
  return (poll.value.votes[optionId] ?? []).length;
};

const getPercentage = (optionId: string): number => {
  if (totalVotes.value === 0) return 0;
  return Math.round((getVoteCount(optionId) / totalVotes.value) * 100);
};

// Anti-double-fire: record which option is currently being sent and ignore
// a *repeat* click on the same option within a short window. Clicks on a
// different option are always allowed (MSC3381 last-vote-wins) so the user
// can immediately correct a mistaken tap.
const pendingVote = ref<string | null>(null);
let pendingClearTimer: ReturnType<typeof setTimeout> | null = null;

const clearPending = () => {
  if (pendingClearTimer) {
    clearTimeout(pendingClearTimer);
    pendingClearTimer = null;
  }
  pendingVote.value = null;
};

onUnmounted(clearPending);

const handleVote = (optionId: string) => {
  if (poll.value.ended) return;
  // Duplicate click on the option we're already sending — dedupe.
  if (pendingVote.value === optionId) return;
  // Already the server-confirmed vote — nothing to do.
  if (poll.value.myVote === optionId) return;

  pendingVote.value = optionId;
  if (pendingClearTimer) clearTimeout(pendingClearTimer);
  pendingClearTimer = setTimeout(() => {
    pendingVote.value = null;
    pendingClearTimer = null;
  }, 800);

  emit("vote", optionId);
};
</script>

<template>
  <div class="flex flex-col gap-2 py-1">
    <!-- Question -->
    <div class="text-sm font-semibold" :class="isOwn ? 'text-white' : 'text-text-color'">
      {{ poll.question }}
    </div>

    <!-- Options -->
    <div class="flex flex-col gap-1.5">
      <button
        v-for="option in poll.options"
        :key="option.id"
        type="button"
        class="relative overflow-hidden rounded-lg px-3 py-2 text-left text-sm transition-colors"
        :class="[
          poll.ended
            ? 'cursor-default'
            : isOwn
              ? 'hover:bg-white/15 cursor-pointer'
              : 'hover:bg-neutral-grad-0 cursor-pointer',
          isOwn ? 'bg-white/10' : 'bg-neutral-grad-0/60',
          poll.myVote === option.id ? (isOwn ? 'ring-1 ring-white/40' : 'ring-1 ring-color-bg-ac/40') : '',
        ]"
        :disabled="poll.ended"
        :aria-pressed="poll.myVote === option.id"
        @click.stop="handleVote(option.id)"
      >
        <!-- Progress bar (shown after voting or when ended) -->
        <div
          v-if="hasVoted || poll.ended"
          class="absolute inset-0 transition-all duration-300"
          :class="isOwn ? 'bg-white/15' : 'bg-color-bg-ac/10'"
          :style="{ width: `${getPercentage(option.id)}%`, pointerEvents: 'none' }"
        />
        <div class="relative flex items-center justify-between gap-2">
          <span :class="isOwn ? 'text-white' : 'text-text-color'">
            {{ option.text }}
          </span>
          <span
            v-if="hasVoted || poll.ended"
            class="shrink-0 text-xs font-medium"
            :class="isOwn ? 'text-white/70' : 'text-text-on-main-bg-color'"
          >
            {{ getPercentage(option.id) }}%
          </span>
        </div>
      </button>
    </div>

    <!-- Footer -->
    <div class="flex items-center justify-between">
      <span class="text-[11px]" :class="isOwn ? 'text-white/50' : 'text-text-on-main-bg-color'">
        {{ totalVotes }} vote{{ totalVotes !== 1 ? "s" : "" }}
        <template v-if="poll.ended"> &middot; Final results</template>
      </span>
      <button
        v-if="isOwn && !poll.ended"
        type="button"
        class="text-[11px] hover:underline"
        :class="isOwn ? 'text-white/70' : 'text-color-bg-ac'"
        @click.stop="emit('end')"
      >
        End poll
      </button>
    </div>
  </div>
</template>
