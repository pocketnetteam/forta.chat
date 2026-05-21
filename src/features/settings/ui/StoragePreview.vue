<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from "vue";
import { getMediaCache, type MediaCacheIndexEntry } from "@/shared/lib/media-cache";
import { displayName } from "../lib/storage-display";
import { isNative } from "@/shared/lib/platform";
import { ZoomableImage } from "@/shared/ui/zoomable-image";

interface Props {
  entry: MediaCacheIndexEntry;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  close: [];
  deleted: [];
}>();

const { t } = useI18n();
const blobUrl = ref<string | null>(null);
const loadError = ref<string | null>(null);
const loading = ref(true);

let createdUrl: string | null = null;
/** Guard against the unmount-during-load race: if the user taps "delete"
 *  or otherwise dismisses the preview while `cache.get` is still in
 *  flight, the awaited resolution must not create a new object URL that
 *  no `onUnmounted` will ever revoke. */
let unmounted = false;
/** Capacitor temp file written by `openExternally`. Tracked here so the
 *  preview's unmount path can clean it up even if FileOpener handed it
 *  off to an external viewer that holds it open in the background. */
let nativeTempPath: string | null = null;

const isImage = computed(() => props.entry.mime.startsWith("image/"));
const isVideo = computed(() => props.entry.mime.startsWith("video/"));
const isAudio = computed(
  () => props.entry.mime.startsWith("audio/") || props.entry.category === "voice",
);

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
};

const friendlyName = computed(() => displayName(props.entry, t));

onMounted(async () => {
  loading.value = true;
  const cache = getMediaCache();
  if (!cache) {
    loadError.value = t("storage.previewUnavailable");
    loading.value = false;
    return;
  }
  try {
    const blob = await cache.get(props.entry.mxc);
    // Bail if the component was unmounted while we were awaiting Dexie /
    // Filesystem — otherwise the URL we create here would never be
    // revoked (onUnmounted already ran with createdUrl still null).
    if (unmounted) return;
    if (!blob) {
      loadError.value = t("storage.previewUnavailable");
      loading.value = false;
      return;
    }
    createdUrl = URL.createObjectURL(blob);
    blobUrl.value = createdUrl;
  } catch (e) {
    console.warn("[StoragePreview] load failed:", e);
    if (!unmounted) loadError.value = t("storage.previewUnavailable");
  } finally {
    if (!unmounted) loading.value = false;
  }
});

onUnmounted(async () => {
  unmounted = true;
  if (createdUrl) {
    try { URL.revokeObjectURL(createdUrl); } catch { /* ignore */ }
    createdUrl = null;
  }
  // Wipe the Capacitor temp file (if we wrote one) — it lives in
  // `Directory.Cache/media-cache-preview/`, which `clearMediaCache` also
  // sweeps on logout, but cleaning it eagerly here avoids the disk-bloat
  // pattern of preview-open + dismiss without action.
  if (nativeTempPath) {
    const path = nativeTempPath;
    nativeTempPath = null;
    try {
      const { Filesystem, Directory } = await import("@capacitor/filesystem");
      await Filesystem.deleteFile({ path, directory: Directory.Cache });
    } catch { /* file may already be gone — ignore */ }
  }
});

const handleDelete = async () => {
  try {
    const cache = getMediaCache();
    if (cache) await cache.delete(props.entry.mxc);
    emit("deleted");
  } catch (e) {
    console.warn("[StoragePreview] delete failed:", e);
  }
};

/** Hand a file off to the OS so a real PDF / archive / doc viewer can
 *  open it. Native (Capacitor) writes the blob to a temp Cache file and
 *  asks FileOpener to pick the right app; web/Electron falls back to a
 *  download <a>. We avoid invoking this for audio/video/image inside the
 *  preview because we already render them inline. */
const openExternally = async () => {
  if (!blobUrl.value) return;
  const fileName = friendlyName.value || "file";
  try {
    if (isNative) {
      const { Filesystem, Directory } = await import("@capacitor/filesystem");
      const { FileOpener } = await import("@capacitor-community/file-opener");
      const res = await fetch(blobUrl.value);
      const blob = await res.blob();
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = reader.result as string;
          const comma = result.indexOf(",");
          resolve(comma >= 0 ? result.slice(comma + 1) : result);
        };
        reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
        reader.readAsDataURL(blob);
      });
      // Write to a dedicated subdirectory so logout's `clearMediaCache`
      // wipes it along with the rest of the cache. Writing to the root
      // of `Directory.Cache` (as in the first cut) would leave plaintext
      // documents accessible to the next user logging in on the device.
      const path = `media-cache-preview/${fileName}`;
      const written = await Filesystem.writeFile({
        path,
        data: base64,
        directory: Directory.Cache,
        recursive: true,
      });
      nativeTempPath = path;
      await FileOpener.open({
        filePath: written.uri,
        contentType: props.entry.mime || "application/octet-stream",
        openWithDefault: true,
      });
    } else {
      const a = document.createElement("a");
      a.href = blobUrl.value;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  } catch (e) {
    console.warn("[StoragePreview] external open failed:", e);
  }
};
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-0 z-50 flex flex-col bg-black/90"
      @click.self="emit('close')"
    >
      <!-- Header bar -->
      <div class="safe-top flex items-center gap-3 px-4 py-3 text-white">
        <button
          class="flex h-9 w-9 items-center justify-center rounded-full transition-colors hover:bg-white/10"
          @click="emit('close')"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm font-medium">{{ friendlyName }}</div>
          <div class="truncate text-xs text-white/60">{{ formatBytes(entry.size) }}</div>
        </div>
        <button
          class="flex h-9 w-9 items-center justify-center rounded-full transition-colors hover:bg-white/10"
          :title="t('storage.deleteEntry')"
          @click="handleDelete"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-2 14H7L5 6" />
            <path d="M10 11v6M14 11v6" />
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
          </svg>
        </button>
      </div>

      <!-- Content -->
      <div
        class="flex flex-1 items-center justify-center px-4 pb-safe"
        @click.self="emit('close')"
      >
        <div v-if="loading" class="text-white/60 text-sm">{{ t('storage.previewLoading') }}</div>

        <div v-else-if="loadError" class="text-center text-white/70 text-sm">
          {{ loadError }}
        </div>

        <!-- Photo: full pan / pinch-zoom / double-tap / swipe-down-to-close. -->
        <ZoomableImage
          v-else-if="isImage && blobUrl"
          :src="blobUrl"
          :alt="friendlyName"
          class="h-full w-full"
          @click.stop
          @close="emit('close')"
        />

        <video
          v-else-if="isVideo && blobUrl"
          :src="blobUrl"
          controls
          autoplay
          class="max-h-full max-w-full"
          @click.stop
        />

        <div
          v-else-if="isAudio && blobUrl"
          class="flex w-full max-w-md flex-col items-center gap-4 rounded-2xl bg-white/5 p-6"
          @click.stop
        >
          <div class="flex h-20 w-20 items-center justify-center rounded-full bg-color-bg-ac/30 text-white">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
          <div class="text-center text-white">
            <div class="text-base font-medium">{{ friendlyName }}</div>
            <div class="mt-1 text-xs text-white/60">{{ formatBytes(entry.size) }}</div>
          </div>
          <audio :src="blobUrl" controls autoplay class="w-full" />
        </div>

        <!-- Generic file — offer native open -->
        <div
          v-else-if="blobUrl"
          class="flex w-full max-w-md flex-col items-center gap-4 rounded-2xl bg-white/5 p-6 text-white"
          @click.stop
        >
          <div class="flex h-20 w-20 items-center justify-center rounded-full bg-white/10">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
          </div>
          <div class="text-center">
            <div class="text-base font-medium">{{ friendlyName }}</div>
            <div class="mt-1 text-xs text-white/60">{{ formatBytes(entry.size) }}</div>
          </div>
          <button
            class="rounded-lg bg-color-bg-ac px-6 py-2.5 text-sm font-medium text-text-on-bg-ac-color transition-opacity hover:opacity-90"
            @click="openExternally"
          >
            {{ t('storage.openFile') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
