<script setup lang="ts">
import { computed } from "vue";
import type { ChatRoom } from "../model/types";
import { UserAvatar } from "@/entities/user";
import Avatar from "@/shared/ui/avatar/Avatar.vue";

const props = withDefaults(
  defineProps<{
    room: ChatRoom;
    /** For Matrix / URL avatars — initials while title is resolving */
    initialsName?: string;
    size?: "sm" | "md" | "lg" | "xl";
    /**
     * Pocketnet avatars use lazy IntersectionObserver by default; headers are always
     * visible — use eager so the image is not stuck on an empty circle.
     */
    eager?: boolean;
  }>(),
  { size: "md", eager: true, initialsName: "" },
);

const pocketAddress = computed(() => {
  const a = props.room.avatar;
  if (!a?.startsWith("__pocketnet__:")) return "";
  return a.replace("__pocketnet__:", "");
});

const matrixAvatarName = computed(() => props.initialsName || props.room.name);

/** Remount image pipeline when row data fills in after first paint (Dexie / Matrix race). */
const avatarRenderKey = computed(
  () => `${props.room.id}:${props.room.avatar ?? ""}:${pocketAddress.value}`,
);
</script>

<template>
  <UserAvatar
    v-if="pocketAddress"
    :key="avatarRenderKey"
    :address="pocketAddress"
    :size="size"
    :eager="eager"
  />
  <Avatar
    v-else
    :key="avatarRenderKey"
    :src="room.avatar"
    :name="matrixAvatarName"
    :size="size"
  />
</template>
