<script setup lang="ts">
import { useAuthStore } from "@/entities/auth";

const router = useRouter();
const authStore = useAuthStore();

const handleLogout = async () => {
  await authStore.logout();
  router.replace({ name: "WelcomePage" });
};
</script>

<template>
  <Button variant="danger" @click="handleLogout">
    Logout
  </Button>
</template>
