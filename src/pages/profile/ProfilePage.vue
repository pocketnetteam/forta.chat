<script setup lang="ts">
import MainLayout from "@/widgets/layouts/MainLayout.vue";
import { UserProfileInfo } from "@/features/user-profile";

const router = useRouter();

const goToEdit = () => {
  router.push({ name: "ProfileEditPage" });
};
</script>

<template>
  <MainLayout>
    <div class="mx-auto max-w-2xl px-4 py-6 md:px-6">
      <UserProfileInfo />
      <div class="mt-6">
        <Button variant="outline" @click="goToEdit">Edit Profile</Button>
      </div>
    </div>
  </MainLayout>
</template>
