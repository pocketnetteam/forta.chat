<template>
  <Teleport to="body">
    <div v-if="particles.length" class="reaction-effect-overlay">
      <span
        v-for="p in particles"
        :key="p.id"
        class="reaction-particle"
        :style="p.style"
      >
        {{ p.emoji }}
      </span>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { watch, ref, reactive } from "vue";

interface Particle {
  id: number;
  emoji: string;
  style: Record<string, string>;
}

const props = defineProps<{
  emoji: string | null;
}>();

const particles = reactive<Particle[]>([]);
let nextId = 0;

function rand(min: number, max: number) {
  return Math.random() * (max - min) + min;
}

function spawnParticles(emoji: string) {
  const config = getEffectConfig(emoji);
  const newParticles: Particle[] = [];

  for (let i = 0; i < config.count; i++) {
    const id = nextId++;
    const delay = rand(0, 0.4);
    const duration = rand(1.2, 2.0);
    const rotation = Math.round(rand(-45, 45));

    const style: Record<string, string> = {
      left: `${rand(10, 90)}%`,
      fontSize: `${config.type === "burst" ? 72 : Math.round(rand(20, 36))}px`,
      animationName: config.animation,
      animationDuration: `${duration}s`,
      animationDelay: `${delay}s`,
      animationTimingFunction: "ease-out",
      animationFillMode: "forwards",
      "--rotation": `${rotation}deg`,
    };

    if (config.type === "float-up") {
      style.bottom = "0";
      style.top = "auto";
    } else if (config.type === "fall-down") {
      style.top = "0";
      style.bottom = "auto";
    } else {
      // burst — center
      style.top = "50%";
      style.left = "50%";
      style.transform = "translate(-50%, -50%)";
    }

    newParticles.push({ id, emoji: config.display, style });
  }

  particles.push(...newParticles);

  setTimeout(() => {
    const ids = new Set(newParticles.map((p) => p.id));
    let i = particles.length;
    while (i--) {
      if (ids.has(particles[i].id)) {
        particles.splice(i, 1);
      }
    }
  }, 2500);
}

function getEffectConfig(emoji: string) {
  switch (emoji) {
    case "❤️":
      return { count: 15, type: "float-up" as const, animation: "float-up", display: "❤️" };
    case "🔥":
      return { count: 12, type: "float-up" as const, animation: "float-up", display: "🔥" };
    case "🎉":
      return { count: 25, type: "fall-down" as const, animation: "fall-down", display: "🎉" };
    case "👍":
      return { count: 1, type: "burst" as const, animation: "burst-pop", display: "👍" };
    case "😂":
      return { count: 12, type: "fall-down" as const, animation: "fall-down", display: "😂" };
    default:
      return { count: 8, type: "burst" as const, animation: "burst-pop", display: emoji };
  }
}

watch(
  () => props.emoji,
  (val) => {
    if (val) {
      spawnParticles(val);
    }
  }
);
</script>

<style scoped>
.reaction-effect-overlay {
  position: fixed;
  inset: 0;
  z-index: 99999;
  pointer-events: none;
  overflow: hidden;
}

.reaction-particle {
  position: absolute;
  opacity: 0;
  animation-iteration-count: 1;
  will-change: transform, opacity;
  pointer-events: none;
}

@keyframes float-up {
  0% {
    opacity: 1;
    transform: translateY(0) rotate(0deg) scale(1);
  }
  70% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    transform: translateY(-120vh) rotate(var(--rotation, 30deg)) scale(0.6);
  }
}

@keyframes fall-down {
  0% {
    opacity: 1;
    transform: translateY(0) rotate(0deg) scale(1);
  }
  70% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    transform: translateY(120vh) rotate(var(--rotation, 30deg)) scale(0.6);
  }
}

@keyframes burst-pop {
  0% {
    opacity: 1;
    transform: translate(-50%, -50%) scale(0);
  }
  50% {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1.5);
  }
  100% {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0);
  }
}
</style>
