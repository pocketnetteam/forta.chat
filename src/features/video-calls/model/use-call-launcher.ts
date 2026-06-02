import { ref, type Ref } from "vue";
import { getChatDb, isChatDbReady } from "@/shared/lib/local-db";
import { useCallService } from "./call-service";
import { useCallProviderSettings } from "./use-call-provider-settings";
import { resolveCallAction, type CallOption } from "./call-action";
import { sendCallLink } from "./send-call-link";

export interface LaunchOptions {
  /** Long-press / "choose method" — always show the picker. */
  forcePicker?: boolean;
}

/**
 * Centralized "Позвонить" handler (WEE-57). Every call entry point (chat
 * header, profile panel, info panel) routes through `launch()` so the
 * native-vs-external decision lives in one place. When a picker is needed,
 * the consuming component renders `<CallProviderPicker>` bound to the
 * exposed reactive state.
 */
export function useCallLauncher(): {
  pickerOpen: Ref<boolean>;
  pickerOptions: Ref<CallOption[]>;
  launch: (roomId: string, kind: "voice" | "video", isDm: boolean, opts?: LaunchOptions) => Promise<void>;
  pick: (option: CallOption) => Promise<void>;
  closePicker: () => void;
} {
  const callService = useCallService();
  const { useExternalProviders } = useCallProviderSettings();

  const pickerOpen = ref(false);
  const pickerOptions = ref<CallOption[]>([]);
  const pendingRoomId = ref("");
  const pendingKind = ref<"voice" | "video">("voice");

  async function launch(
    roomId: string,
    kind: "voice" | "video",
    isDm: boolean,
    opts: LaunchOptions = {},
  ): Promise<void> {
    if (!roomId) return;

    // DB not ready → nothing configurable, keep the existing native behavior.
    if (!isChatDbReady()) {
      callService.startCall(roomId, kind);
      return;
    }

    let providers;
    try {
      providers = await getChatDb().callProviders.toArray();
    } catch (e) {
      console.error("[useCallLauncher] failed to read providers, falling back to native:", e);
      callService.startCall(roomId, kind);
      return;
    }

    const action = resolveCallAction({
      providers,
      useExternal: useExternalProviders.value,
      isDm,
      forcePicker: opts.forcePicker,
    });

    if (action.type === "native") {
      callService.startCall(roomId, kind);
      return;
    }
    if (action.type === "send") {
      await sendCallLink(roomId, action.provider, kind);
      return;
    }

    // action.type === "picker"
    pendingRoomId.value = roomId;
    pendingKind.value = kind;
    pickerOptions.value = action.options;
    pickerOpen.value = true;
  }

  async function pick(option: CallOption): Promise<void> {
    pickerOpen.value = false;
    if (option.type === "native") {
      callService.startCall(pendingRoomId.value, pendingKind.value);
      return;
    }
    await sendCallLink(pendingRoomId.value, option.provider, pendingKind.value);
  }

  function closePicker(): void {
    pickerOpen.value = false;
  }

  return { pickerOpen, pickerOptions, launch, pick, closePicker };
}
