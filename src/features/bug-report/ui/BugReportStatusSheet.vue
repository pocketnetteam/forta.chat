<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useMobile } from "@/shared/lib/composables/use-media-query";
import { useAndroidBackHandler } from "@/shared/lib/composables/use-android-back-handler";
import { useBugReportStatus } from "../model/use-bug-report-status";

interface Props {
  show: boolean;
  /** Bastyon address of the signed-in user */
  address: string;
  /** Legacy prop — retained so callers don't break, currently unused. */
  mode?: "review" | "manage";
}

const props = defineProps<Props>();
const emit = defineEmits<{ close: [] }>();

const { allIssues, markUnresolved, closeUserIssue } = useBugReportStatus();
const { t } = useI18n();
const isMobile = useMobile();

const reasonDrafts = ref<Record<number, string>>({});
const actionFor = ref<{ number: number; kind: "reopen" | "close" } | null>(null);
const submitting = ref<number | null>(null);
const submitErrorFor = ref<number | null>(null);

const issuesToShow = computed(() => allIssues.value);

useAndroidBackHandler("bug-report-status", 90, () => {
  if (!props.show) return false;
  handleClose();
  return true;
});

const onKeydown = (e: KeyboardEvent) => {
  if (e.key === "Escape") {
    e.stopPropagation();
    handleClose();
  }
};

watch(
  () => props.show,
  (v) => {
    if (v) document.addEventListener("keydown", onKeydown);
    else document.removeEventListener("keydown", onKeydown);
  },
);

const handleClose = () => {
  actionFor.value = null;
  submitErrorFor.value = null;
  emit("close");
};

const startAction = (issueNumber: number, kind: "reopen" | "close") => {
  actionFor.value = { number: issueNumber, kind };
  if (reasonDrafts.value[issueNumber] === undefined) {
    reasonDrafts.value[issueNumber] = "";
  }
  submitErrorFor.value = null;
};

const cancelAction = () => {
  actionFor.value = null;
};

const submitAction = async (issueNumber: number) => {
  if (submitting.value !== null || !actionFor.value) return;
  const kind = actionFor.value.kind;
  submitting.value = issueNumber;
  submitErrorFor.value = null;
  try {
    const reason = reasonDrafts.value[issueNumber] ?? "";
    const ok =
      kind === "reopen"
        ? await markUnresolved(props.address, issueNumber, reason)
        : await closeUserIssue(props.address, issueNumber, reason);
    if (!ok) {
      submitErrorFor.value = issueNumber;
      return;
    }
    actionFor.value = null;
    delete reasonDrafts.value[issueNumber];
  } finally {
    submitting.value = null;
  }
};

const stripPlatformPrefix = (title: string) =>
  title.replace(/^\[(android|ios|electron|web)\]\s*/i, "");

void props.mode;
</script>

<template>
  <Teleport to="body">
    <transition name="brs-fade">
      <div
        v-if="props.show"
        class="fixed inset-0 z-[60] flex justify-center"
        :class="isMobile ? 'items-end' : 'items-center bg-black/40'"
        @click.self="handleClose"
      >
        <transition :name="isMobile ? 'brs-slide' : 'brs-scale'" appear>
          <div
            v-if="props.show"
            class="flex flex-col bg-background-total-theme"
            :class="
              isMobile
                ? 'h-full w-full safe-y'
                : 'my-auto max-h-[75vh] w-full max-w-md rounded-xl shadow-xl'
            "
          >
            <!-- Header -->
            <div
              class="flex shrink-0 items-center justify-between border-b border-neutral-grad-0 px-4 py-3"
            >
              <button
                class="flex h-8 w-8 items-center justify-center rounded-full text-text-on-main-bg-color hover:bg-neutral-grad-0"
                :aria-label="t('common.cancel')"
                @click="handleClose"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <path d="M18 6L6 18" />
                  <path d="M6 6l12 12" />
                </svg>
              </button>
              <span class="truncate text-base font-semibold text-text-color">
                {{ t("bugReportStatus.manageTitle") }}
              </span>
              <div class="w-8" />
            </div>

            <!-- Subtitle -->
            <div
              class="shrink-0 border-b border-neutral-grad-0 px-4 py-3 text-xs leading-snug text-text-on-main-bg-color"
            >
              {{ t("bugReportStatus.manageSubtitle") }}
            </div>

            <!-- List -->
            <ul
              class="min-h-0 flex-1 overflow-y-auto px-4 py-3"
              :class="isMobile ? 'pb-safe' : ''"
            >
              <li
                v-for="issue in issuesToShow"
                :key="issue.number"
                class="mb-3 rounded-xl border border-neutral-grad-0 bg-background-total-theme p-3 last:mb-0"
              >
                <div class="flex items-start gap-2">
                  <span
                    class="mt-0.5 shrink-0 rounded-md bg-neutral-grad-0 px-1.5 py-0.5 font-mono text-[11px] text-text-on-main-bg-color"
                  >
                    #{{ issue.number }}
                  </span>
                  <span
                    class="mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                    :class="
                      issue.state === 'open'
                        ? 'bg-color-good/15 text-color-good'
                        : 'bg-neutral-grad-1 text-text-on-main-bg-color'
                    "
                  >
                    {{
                      issue.state === "open"
                        ? t("bugReportStatus.stateOpen")
                        : t("bugReportStatus.stateClosed")
                    }}
                  </span>
                  <p
                    class="min-w-0 flex-1 break-words text-sm leading-snug text-text-color"
                  >
                    {{ stripPlatformPrefix(issue.title) }}
                  </p>
                  <a
                    :href="issue.url"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="shrink-0 rounded-md p-1 text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0 hover:text-color-bg-ac"
                    :aria-label="t('bugReportStatus.viewOnGithub')"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                    >
                      <path
                        d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"
                      />
                      <polyline points="15 3 21 3 21 9" />
                      <line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                  </a>
                </div>

                <div
                  v-if="actionFor?.number !== issue.number"
                  class="mt-3 flex gap-2"
                >
                  <button
                    v-if="issue.state === 'closed'"
                    class="flex-1 rounded-lg bg-color-bg-ac px-3 py-2 text-sm font-medium text-text-on-bg-ac-color transition-opacity hover:opacity-80"
                    @click="startAction(issue.number, 'reopen')"
                  >
                    {{ t("bugReportStatus.reopenBtn") }}
                  </button>
                  <button
                    v-else
                    class="flex-1 rounded-lg bg-neutral-grad-0 px-3 py-2 text-sm font-medium text-text-color transition-colors hover:bg-neutral-grad-1"
                    @click="startAction(issue.number, 'close')"
                  >
                    {{ t("bugReportStatus.closeBtn") }}
                  </button>
                </div>

                <div v-else class="mt-3 flex flex-col gap-2">
                  <label
                    :for="`reason-${issue.number}`"
                    class="text-xs text-text-on-main-bg-color"
                  >
                    {{
                      actionFor?.kind === "close"
                        ? t("bugReportStatus.closeReasonLabel")
                        : t("bugReportStatus.notResolvedReasonLabel")
                    }}
                  </label>
                  <textarea
                    :id="`reason-${issue.number}`"
                    v-model="reasonDrafts[issue.number]"
                    rows="2"
                    :placeholder="
                      actionFor?.kind === 'close'
                        ? t('bugReportStatus.closeReasonPlaceholder')
                        : t('bugReportStatus.notResolvedReasonPlaceholder')
                    "
                    class="w-full resize-none rounded-lg border border-neutral-grad-0 bg-background-total-theme p-2 text-sm text-text-color outline-none transition-colors focus:border-color-bg-ac"
                  />
                  <div class="flex gap-2">
                    <button
                      class="flex-1 rounded-lg px-3 py-2 text-sm text-text-on-main-bg-color transition-colors hover:bg-neutral-grad-0"
                      :disabled="submitting === issue.number"
                      @click="cancelAction"
                    >
                      {{ t("common.cancel") }}
                    </button>
                    <button
                      class="flex-1 rounded-lg bg-color-bg-ac px-3 py-2 text-sm font-medium text-text-on-bg-ac-color transition-opacity hover:opacity-80 disabled:opacity-40"
                      :disabled="submitting === issue.number"
                      @click="submitAction(issue.number)"
                    >
                      {{
                        submitting === issue.number
                          ? t("bugReportStatus.submitting")
                          : actionFor?.kind === "close"
                            ? t("bugReportStatus.closeSubmit")
                            : t("bugReportStatus.notResolvedSubmit")
                      }}
                    </button>
                  </div>
                  <p
                    v-if="submitErrorFor === issue.number"
                    class="text-xs text-color-bad"
                  >
                    {{ t("bugReportStatus.submitError") }}
                  </p>
                </div>
              </li>
            </ul>
          </div>
        </transition>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.brs-fade-enter-active {
  transition: opacity 0.25s ease-out;
}
.brs-fade-leave-active {
  transition: opacity 0.2s ease-in;
}
.brs-fade-enter-from,
.brs-fade-leave-to {
  opacity: 0;
}

.brs-slide-enter-active {
  transition: transform 0.3s cubic-bezier(0.32, 0.72, 0, 1);
}
.brs-slide-leave-active {
  transition: transform 0.2s ease-in;
}
.brs-slide-enter-from,
.brs-slide-leave-to {
  transform: translateY(100%);
}

.brs-scale-enter-active {
  transition:
    transform 0.2s cubic-bezier(0.32, 0.72, 0, 1),
    opacity 0.2s ease-out;
}
.brs-scale-leave-active {
  transition:
    transform 0.15s ease-in,
    opacity 0.15s ease-in;
}
.brs-scale-enter-from,
.brs-scale-leave-to {
  transform: scale(0.95);
  opacity: 0;
}
</style>
