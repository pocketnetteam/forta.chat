<script setup lang="ts">
import Modal from "@/shared/ui/modal/Modal.vue";
import { useAuthStore } from "@/entities/auth";
import { useNativeShare } from "@/shared/lib/composables/use-native-share";
import { isNative } from "@/shared/lib/platform";
import { APP_PUBLIC_URL } from "@/shared/config";

const props = defineProps<{ show: boolean }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const authStore = useAuthStore();
const { share } = useNativeShare({
  copiedMessage: t('share.linkCopied'),
  copyFailedMessage: t('share.copyFailed'),
});

const copied = ref(false);

const inviteLink = computed(() => {
  return `${APP_PUBLIC_URL}/#/invite?ref=${authStore.address}`;
});

const copyLink = async () => {
  try {
    await navigator.clipboard.writeText(inviteLink.value);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 2000);
  } catch {
    // Fallback: input field has @focus select
  }
};

const handleNativeShare = async () => {
  await share({
    title: t("invite.title"),
    text: "Join me on Forta Chat!",
    url: inviteLink.value,
  });
};

const shareUrl = (platform: string) => {
  const text = encodeURIComponent("Join me on Forta Chat!");
  const url = encodeURIComponent(inviteLink.value);

  const urls: Record<string, string> = {
    telegram: `https://t.me/share/url?url=${url}&text=${text}`,
    whatsapp: `https://wa.me/?text=${text}%20${url}`,
    twitter: `https://twitter.com/intent/tweet?text=${text}&url=${url}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${url}`,
    email: `mailto:?subject=${text}&body=${text}%20${url}`,
  };

  window.open(urls[platform], "_blank", "noopener,noreferrer");
};
</script>

<template>
  <Modal :show="props.show" :aria-label="t('invite.title')" @close="emit('close')">
    <div class="flex flex-col items-center gap-5">
      <!-- Header -->
      <div class="flex flex-col items-center gap-2 text-center">
        <div class="flex h-14 w-14 items-center justify-center rounded-full bg-color-bg-ac/15">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--color-txt-ac))" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <line x1="19" y1="8" x2="19" y2="14" />
            <line x1="22" y1="11" x2="16" y2="11" />
          </svg>
        </div>
        <h2 class="text-lg font-semibold text-text-color">{{ t("invite.title") }}</h2>
        <p class="text-sm text-text-on-main-bg-color">{{ t("invite.subtitle") }}</p>
      </div>

      <!-- Link field -->
      <div class="flex w-full items-center gap-2 rounded-lg border border-neutral-grad-0 bg-background-secondary-theme p-2">
        <input
          :value="inviteLink"
          readonly
          class="min-w-0 flex-1 bg-transparent text-sm text-text-color outline-none"
          @focus="($event.target as HTMLInputElement).select()"
        />
        <button
          class="btn-press shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors"
          :class="copied
            ? 'bg-color-good/15 text-color-good'
            : 'bg-color-bg-ac/15 text-color-txt-ac hover:bg-color-bg-ac/25'"
          @click="copyLink"
        >
          {{ copied ? t("invite.copied") : t("invite.copyLink") }}
        </button>
      </div>

      <!-- Native share (Android/iOS) -->
      <button
        v-if="isNative"
        class="btn-press flex w-full items-center justify-center gap-2 rounded-lg bg-color-bg-ac py-3 text-sm font-medium text-white transition-colors hover:bg-color-bg-ac-1"
        @click="handleNativeShare"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
          <polyline points="16 6 12 2 8 6" />
          <line x1="12" y1="2" x2="12" y2="15" />
        </svg>
        {{ t("share.nativeShare") }}
      </button>

      <!-- Web share buttons (browser only) -->
      <div v-else class="flex w-full flex-col gap-2">
        <span class="text-xs font-medium uppercase tracking-wider text-text-on-main-bg-color">
          {{ t("invite.shareOn") }}
        </span>
        <div class="grid grid-cols-5 gap-2">
          <!-- Telegram -->
          <button
            class="btn-press flex flex-col items-center gap-1.5 rounded-xl p-2 transition-colors hover:bg-neutral-grad-0"
            @click="shareUrl('telegram')"
          >
            <div class="flex h-10 w-10 items-center justify-center rounded-full" style="background: #2AABEE">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                <path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z" />
              </svg>
            </div>
            <span class="text-[10px] text-text-on-main-bg-color">Telegram</span>
          </button>

          <!-- WhatsApp -->
          <button
            class="btn-press flex flex-col items-center gap-1.5 rounded-xl p-2 transition-colors hover:bg-neutral-grad-0"
            @click="shareUrl('whatsapp')"
          >
            <div class="flex h-10 w-10 items-center justify-center rounded-full" style="background: #25D366">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
              </svg>
            </div>
            <span class="text-[10px] text-text-on-main-bg-color">WhatsApp</span>
          </button>

          <!-- Twitter/X -->
          <button
            class="btn-press flex flex-col items-center gap-1.5 rounded-xl p-2 transition-colors hover:bg-neutral-grad-0"
            @click="shareUrl('twitter')"
          >
            <div class="x-icon flex h-10 w-10 items-center justify-center rounded-full">
              <svg width="16" height="16" viewBox="0 0 24 24" class="x-icon-svg">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
            </div>
            <span class="text-[10px] text-text-on-main-bg-color">X</span>
          </button>

          <!-- Facebook -->
          <button
            class="btn-press flex flex-col items-center gap-1.5 rounded-xl p-2 transition-colors hover:bg-neutral-grad-0"
            @click="shareUrl('facebook')"
          >
            <div class="flex h-10 w-10 items-center justify-center rounded-full" style="background: #1877F2">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
              </svg>
            </div>
            <span class="text-[10px] text-text-on-main-bg-color">Facebook</span>
          </button>

          <!-- Email -->
          <button
            class="btn-press flex flex-col items-center gap-1.5 rounded-xl p-2 transition-colors hover:bg-neutral-grad-0"
            @click="shareUrl('email')"
          >
            <div class="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-grad-2">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="2" y="4" width="20" height="16" rx="2" />
                <path d="M22 7l-10 7L2 7" />
              </svg>
            </div>
            <span class="text-[10px] text-text-on-main-bg-color">Email</span>
          </button>
        </div>
      </div>
    </div>
  </Modal>
</template>

<style scoped>
/* X/Twitter icon: dark bg with white fill in light, inverted in dark theme */
.x-icon {
  background: rgb(var(--text-color));
}
.x-icon-svg {
  fill: rgb(var(--background-total-theme));
}
</style>
