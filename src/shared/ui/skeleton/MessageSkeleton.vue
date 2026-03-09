<template>
  <div class="space-y-3 px-4 py-3">
    <div v-for="i in 5" :key="i" class="mx-auto max-w-6xl">
      <div class="flex gap-2" :class="i % 3 === 0 ? 'flex-row-reverse' : 'flex-row'">
        <div v-if="i % 3 !== 0" class="h-8 w-8 shrink-0 animate-pulse rounded-full bg-neutral-grad-2" />
        <div
          class="h-8 animate-pulse rounded-2xl bg-neutral-grad-2"
          :style="{ width: `${120 + (i * 37) % 100}px` }"
        />
      </div>
    </div>
  </div>
</template>
