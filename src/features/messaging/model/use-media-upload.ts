import { ref, computed, toRaw } from "vue";
import type { Ref } from "vue";
import { convertHeicToJpeg, isHeicFile } from "./heic-to-jpeg";

export interface MediaFile {
  file: File;
  previewUrl: string;
  type: "image" | "video";
}

export function useMediaUpload() {
  const files: Ref<MediaFile[]> = ref([]);
  const activeIndex = ref(0);
  const caption = ref("");
  const captionAbove = ref(false);
  const sending = ref(false);

  const activeFile = computed(() => files.value[activeIndex.value] ?? null);

  /** Android WebView cannot draw HEIC, so the picked photo had no preview
   *  (audit W2C-04). Convert it right away and keep the JPEG for sending too,
   *  so the send path does not convert it again. */
  const swapInJpeg = async (original: File) => {
    const jpeg = await convertHeicToJpeg(original);
    if (jpeg === original) return;
    const item = files.value.find((f) => toRaw(f.file) === original);
    if (!item) return; // removed while converting
    URL.revokeObjectURL(item.previewUrl);
    item.file = jpeg;
    item.previewUrl = URL.createObjectURL(jpeg);
  };

  const addFiles = (fileList: FileList | File[]) => {
    for (const file of Array.from(fileList)) {
      const type = file.type.startsWith("video/") ? "video" as const : "image" as const;
      files.value.push({
        file,
        previewUrl: URL.createObjectURL(file),
        type,
      });
      if (type === "image" && isHeicFile(file)) void swapInJpeg(file);
    }
    activeIndex.value = 0;
  };

  const removeFile = (index: number) => {
    const removed = files.value.splice(index, 1);
    removed.forEach(f => URL.revokeObjectURL(f.previewUrl));
    if (activeIndex.value >= files.value.length) {
      activeIndex.value = Math.max(0, files.value.length - 1);
    }
  };

  const clear = () => {
    files.value.forEach(f => URL.revokeObjectURL(f.previewUrl));
    files.value = [];
    activeIndex.value = 0;
    caption.value = "";
    captionAbove.value = false;
    sending.value = false;
  };

  return { files, activeIndex, activeFile, caption, captionAbove, sending, addFiles, removeFile, clear };
}
