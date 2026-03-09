<script setup lang="ts">
interface Props {
  modelValue?: number | null;
  average?: number;
  totalVotes?: number;
  readonly?: boolean;
  compact?: boolean;
  submitting?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: null,
  average: 0,
  totalVotes: 0,
  readonly: false,
  compact: false,
  submitting: false,
});

const emit = defineEmits<{ "update:modelValue": [value: number] }>();

const hoverValue = ref(0);

const displayValue = computed(() => {
  if (hoverValue.value > 0) return hoverValue.value;
  if (props.modelValue) return props.modelValue;
  return props.average;
});

const isInteractive = computed(() => !props.readonly && !props.modelValue && !props.submitting);

const onHover = (star: number) => {
  if (isInteractive.value) hoverValue.value = star;
};

const onLeave = () => {
  hoverValue.value = 0;
};

const onClick = (star: number) => {
  if (isInteractive.value) emit("update:modelValue", star);
};
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
          star <= displayValue
            ? 'fill-color-star-yellow text-color-star-yellow'
            : 'fill-none text-text-on-main-bg-color opacity-40',
          isInteractive ? 'hover:scale-110' : '',
          submitting ? 'animate-pulse' : '',
        ]"
        stroke="currentColor"
        stroke-width="1.5"
        @mouseenter="onHover(star)"
        @click="onClick(star)"
      >
        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
      </svg>
    </div>
    <span v-if="!compact && totalVotes > 0" class="text-xs opacity-60">
      {{ average.toFixed(1) }} · {{ totalVotes }}
    </span>
    <span v-if="compact && totalVotes > 0" class="text-[10px] opacity-60">
      {{ average.toFixed(1) }}
    </span>
  </div>
</template>
