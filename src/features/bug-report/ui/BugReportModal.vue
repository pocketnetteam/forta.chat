<script setup lang="ts">
import {
  collectEnvironment,
  sendBugReport,
  trackCreatedIssue,
} from "@/shared/lib/bug-report";
import type { AppEnvironment } from "@/shared/lib/bug-report";
import Modal from "@/shared/ui/modal/Modal.vue";
import { isNative } from "@/shared/lib/platform";
import { useAuthStore } from "@/entities/auth";
import { useBugReport } from "../model/use-bug-report";

const { isOpen, prefillContext, prefillError, close } = useBugReport();
const authStore = useAuthStore();
const { t } = useI18n();

const description = ref("");
const screenshots = ref<{ base64: string; preview: string }[]>([]);
const sending = ref(false);
const sent = ref(false);
const errorMsg = ref("");
const fileInput = ref<HTMLInputElement>();
const environment = ref<AppEnvironment>();
const showExamples = ref(false);

watch(isOpen, async (val) => {
  if (val) {
    // Build prefilled description from context + error
    const parts: string[] = [];
    if (prefillContext.value) {
      parts.push(prefillContext.value);
    }
    if (prefillError.value) {
      parts.push(`\n${t("bugReport.errorLabel")}: ${prefillError.value}`);
    }
    description.value = parts.join("");

    screenshots.value = [];
    sending.value = false;
    sent.value = false;
    errorMsg.value = "";
    showExamples.value = false;
    environment.value = await collectEnvironment();
  }
});

const addScreenshot = (base64: string, format: string) => {
  const preview = `data:image/${format};base64,${base64}`;
  screenshots.value = [...screenshots.value, { base64, preview }];
};

const handleAttachScreenshot = async () => {
  if (isNative) {
    try {
      const { Camera, CameraResultType, CameraSource } = await import(
        "@capacitor/camera"
      );
      const photo = await Camera.getPhoto({
        quality: 80,
        resultType: CameraResultType.Base64,
        source: CameraSource.Photos,
      });
      if (photo.base64String) {
        addScreenshot(photo.base64String, photo.format ?? "png");
        return;
      }
    } catch {
      // User cancelled or plugin unavailable
    }
  }
  fileInput.value?.click();
};

const handleFileChange = (e: Event) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result as string;
    const base64 = dataUrl.split(",")[1];
    const format = file.type.split("/")[1] || "png";
    addScreenshot(base64, format);
  };
  reader.readAsDataURL(file);
  input.value = "";
};

const removeScreenshot = (index: number) => {
  screenshots.value = screenshots.value.filter((_, i) => i !== index);
};

const canSend = computed(
  () => description.value.trim().length > 0 && !sending.value && !sent.value,
);

const handleSend = async () => {
  if (!canSend.value || !environment.value) return;

  sending.value = true;
  errorMsg.value = "";

  try {
    const result = await sendBugReport({
      description: description.value.trim(),
      environment: environment.value,
      screenshots: screenshots.value.map((s) => s.base64),
      reporterAddress: authStore.address ?? undefined,
    });
    if (authStore.address && result.issueNumber) {
      trackCreatedIssue(authStore.address, {
        number: result.issueNumber,
        title: `[${environment.value.platform}] ${description.value.trim().slice(0, 80)}`,
      });
    }
    sent.value = true;
    if (result.screenshotsFailed > 0) {
      errorMsg.value = `${t("bugReport.screenshotUploadFailed")} (${result.uploadError ?? "unknown"})`;
    }
    setTimeout(() => close(), 2500);
  } catch (e) {
    console.error("[BugReport] send failed:", e);
    errorMsg.value = t("bugReport.error");
  } finally {
    sending.value = false;
  }
};
</script>

<template>
  <Modal :show="isOpen" :aria-label="t('bugReport.title')" @close="close">
    <h2 class="mb-1 text-lg font-semibold text-text-color">
      {{ t("bugReport.title") }}
    </h2>
    <p class="mb-4 text-xs text-text-on-main-bg-color">
      {{ t("bugReport.subtitle") }}
    </p>

    <!-- Success state -->
    <div v-if="sent" class="py-6 text-center">
      <svg class="mx-auto mb-2 h-10 w-10 text-color-good" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
        <polyline points="22 4 12 14.01 9 11.01" />
      </svg>
      <p class="text-sm text-color-good">{{ t("bugReport.success") }}</p>
      <p v-if="errorMsg" class="mt-2 text-xs text-color-star-yellow">{{ errorMsg }}</p>
    </div>

    <template v-else>
      <!-- Context banner (when opened from error) -->
      <div
        v-if="prefillContext"
        class="mb-3 rounded-lg bg-color-bad/10 px-3 py-2 text-xs text-color-bad"
      >
        {{ prefillContext }}
      </div>

      <!-- Description -->
      <label class="mb-1 block text-sm text-text-on-main-bg-color">
        {{ t("bugReport.description") }}
      </label>
      <textarea
        v-model="description"
        :placeholder="t('bugReport.descriptionPlaceholder')"
        rows="4"
        class="mb-1 w-full resize-none rounded-lg border border-neutral-grad-0 bg-background-total-theme p-3 text-sm text-text-color outline-none transition-colors focus:border-color-bg-ac"
      />

      <!-- Examples toggle -->
      <button
        class="mb-3 text-xs text-color-bg-ac transition-opacity hover:opacity-70"
        @click="showExamples = !showExamples"
      >
        {{ showExamples ? t("bugReport.hideExamples") : t("bugReport.showExamples") }}
      </button>

      <!-- Examples -->
      <div
        v-if="showExamples"
        class="mb-3 space-y-2 rounded-lg bg-neutral-grad-0/50 p-3 text-xs text-text-on-main-bg-color"
      >
        <p class="font-medium text-text-color">{{ t("bugReport.examplesTitle") }}</p>
        <div class="space-y-1.5">
          <p>{{ t("bugReport.example1") }}</p>
          <p>{{ t("bugReport.example2") }}</p>
          <p>{{ t("bugReport.example3") }}</p>
        </div>
      </div>

      <!-- Screenshots -->
      <div class="mb-4">
        <div v-if="screenshots.length" class="mb-2 flex flex-wrap gap-2">
          <div
            v-for="(shot, idx) in screenshots"
            :key="idx"
            class="relative"
          >
            <img
              :src="shot.preview"
              alt="Screenshot"
              class="h-20 w-20 rounded-lg border border-neutral-grad-0 object-cover"
            />
            <button
              class="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-color-bad text-white shadow"
              @click="removeScreenshot(idx)"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        <button
          class="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-color-bg-ac transition-colors hover:bg-neutral-grad-0"
          @click="handleAttachScreenshot"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
          {{ t("bugReport.attachScreenshot") }}
        </button>
        <input
          ref="fileInput"
          type="file"
          accept="image/*"
          class="hidden"
          @change="handleFileChange"
        />
      </div>

      <!-- Error -->
      <p v-if="errorMsg" class="mb-3 text-sm text-color-bad">
        {{ errorMsg }}
      </p>

      <!-- Actions -->
      <div class="flex justify-end gap-3">
        <button
          class="rounded-lg px-4 py-2 text-sm text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
          @click="close"
        >
          {{ t("common.cancel") }}
        </button>
        <button
          :disabled="!canSend"
          class="rounded-lg bg-color-bg-ac px-4 py-2 text-sm font-medium text-text-on-bg-ac-color transition-opacity disabled:opacity-40"
          :class="{ 'hover:opacity-80': canSend }"
          @click="handleSend"
        >
          {{ sending ? t("bugReport.sending") : t("bugReport.send") }}
        </button>
      </div>
    </template>
  </Modal>
</template>
