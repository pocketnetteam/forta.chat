<script setup lang="ts">
interface Props {
  /** My own rating (1..5) or null if I haven't voted. */
  modelValue?: number | null;
  /** Community average (0..5, may be fractional). */
  average?: number;
  /** Total number of votes (including mine). */
  totalVotes?: number;
  /** Disable all interaction (e.g. own post or other read-only contexts). */
  readonly?: boolean;
  /** Compact size variant for list bubbles. */
  compact?: boolean;
  /** Submit-in-progress state — disables clicks and shows pulse. */
  submitting?: boolean;
  /** Hide the numeric label entirely. */
  hideLabel?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: null,
  average: 0,
  totalVotes: 0,
  readonly: false,
  compact: false,
  submitting: false,
  hideLabel: false,
});

const emit = defineEmits<{ "update:modelValue": [value: number] }>();

const hoverValue = ref(0);

const hasMyVote = computed(() => props.modelValue != null && props.modelValue > 0);

const isInteractive = computed(
  () => !props.readonly && !hasMyVote.value && !props.submitting,
);

type StarState = "my-fill" | "avg-line" | "empty";

function stateFor(star: number): StarState {
  if (isInteractive.value && hoverValue.value > 0) {
    return star <= hoverValue.value ? "my-fill" : "empty";
  }
  if (hasMyVote.value) {
    return star <= (props.modelValue as number) ? "my-fill" : "empty";
  }
  // Round-half-up so the visible filled count matches the rounded label
  // ("5.0" must show 5 stars, not 4 — toFixed(1) rounds 4.99 → "5.0").
  const avgFilled = Math.round(props.average);
  return star <= avgFilled ? "avg-line" : "empty";
}

const onHover = (star: number) => {
  if (isInteractive.value) hoverValue.value = star;
};

const onLeave = () => {
  hoverValue.value = 0;
};

const onClick = (star: number) => {
  if (isInteractive.value) emit("update:modelValue", star);
};

const labelText = computed(() => props.average.toFixed(1));
</script>

<template>
  <div class="inline-flex items-center gap-1">
    <div
      class="flex"
      :class="{ 'cursor-pointer': isInteractive, 'gap-0.5': !compact, 'gap-px': compact }"
      @mouseleave="onLeave"
    >
      <svg
        v-for="star in 5"
        :key="star"
        :width="compact ? 12 : 20"
        :height="compact ? 12 : 20"
        viewBox="0 0 24 24"
        class="transition-colors"
        :class="[
          stateFor(star) === 'my-fill'
            ? 'fill-color-star-yellow text-color-star-yellow'
            : stateFor(star) === 'avg-line'
              ? 'fill-none text-color-star-yellow'
              : 'fill-none text-neutral-grad-2',
          isInteractive ? 'hover:scale-110' : '',
          submitting ? 'animate-pulse' : '',
        ]"
        stroke="currentColor"
        stroke-width="1.75"
        @mouseenter="onHover(star)"
        @click="onClick(star)"
      >
        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
      </svg>
    </div>
    <span
      v-if="!hideLabel"
      :class="[
        compact ? 'text-[10px]' : 'text-xs',
        'text-text-on-main-bg-color',
      ]"
    >
      {{ labelText }}
    </span>
  </div>
</template>
