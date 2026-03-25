<script setup lang="ts">
import MainLayout from "@/widgets/layouts/MainLayout.vue";
import { UserEditForm } from "@/features/user-management";
</script>

<template>
  <MainLayout>
    <div class="mx-auto max-w-2xl px-4 py-6 md:px-6">
      <h1 class="mb-6 text-xl font-bold text-text-color">Edit Profile</h1>
      <UserEditForm />
    </div>
  </MainLayout>
</template>
