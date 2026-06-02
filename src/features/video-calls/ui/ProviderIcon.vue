<script setup lang="ts">
import { computed } from "vue";
import type { CallProviderKind } from "@/entities/chat/model/types";

interface Props {
  kind: CallProviderKind;
  /** Tailwind size classes, default h-9 w-9 */
  sizeClass?: string;
}

const props = withDefaults(defineProps<Props>(), { sizeClass: "h-9 w-9" });

// Distinct, brand-evocative colors so providers are scannable at a glance
// instead of a uniform gray row. Glyphs avoid shipping brand SVG assets.
const STYLE: Record<CallProviderKind, { bg: string; glyph: string }> = {
  zoom: { bg: "bg-[#2D8CFF]", glyph: "Z" },
  google_meet: { bg: "bg-[#00897B]", glyph: "M" },
  jitsi: { bg: "bg-[#1F6FBF]", glyph: "J" },
  custom: { bg: "bg-neutral-grad-2", glyph: "🔗" },
};

const style = computed(() => STYLE[props.kind] ?? STYLE.custom);
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center justify-center rounded-lg font-semibold text-white"
    :class="[props.sizeClass, style.bg]"
    aria-hidden="true"
  >
    {{ style.glyph }}
  </span>
</template>
