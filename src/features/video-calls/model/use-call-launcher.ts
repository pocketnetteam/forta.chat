import { ref, type Ref } from "vue";
import { getChatDb, isChatDbReady } from "@/shared/lib/local-db";
import { useCallService } from "./call-service";
import { resolveCallAction, type CallOption } from "./call-action";
import { sendCallLink } from "./send-call-link";

/** Anchor point (viewport coords) for the desktop context-menu presentation. */
export interface PickerAnchor {
  x: number;
  y: number;
}

/**
 * Centralized "Позвонить" handler (WEE-57). Every call entry point (chat
 * header, profile panel, info panel) routes through `launch()` so the
 * native-vs-external decision lives in one place. When a menu is needed,
 * the consuming component renders `<CallProviderPicker>` bound to the
 * exposed reactive state — a bottom sheet on touch, a context menu on desktop
 * (anchored at the tapped button via `pickerAnchor`).
 */
export function useCallLauncher(): {
  pickerOpen: Ref<boolean>;
  pickerOptions: Ref<CallOption[]>;
  pickerAnchor: Ref<PickerAnchor>;
  launch: (roomId: string, kind: "voice" | "video", isDm: boolean, anchor?: PickerAnchor) => Promise<void>;
  pick: (option: CallOption) => Promise<void>;
  closePicker: () => void;
} {
  const callService = useCallService();

  const pickerOpen = ref(false);
  const pickerOptions = ref<CallOption[]>([]);
  const pickerAnchor = ref<PickerAnchor>({ x: 0, y: 0 });
  const pendingRoomId = ref("");
  const pendingKind = ref<"voice" | "video">("voice");

  async function launch(
    roomId: string,
    kind: "voice" | "video",
    isDm: boolean,
    anchor?: PickerAnchor,
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

    const action = resolveCallAction({ providers, isDm });

    if (action.type === "native") {
      callService.startCall(roomId, kind);
      return;
    }
    if (action.type === "send") {
      await sendCallLink(roomId, action.provider);
      return;
    }

    // action.type === "picker"
    pendingRoomId.value = roomId;
    pendingKind.value = kind;
    pickerOptions.value = action.options;
    if (anchor) pickerAnchor.value = anchor;
    pickerOpen.value = true;
  }

  async function pick(option: CallOption): Promise<void> {
    pickerOpen.value = false;
    if (option.type === "native") {
      callService.startCall(pendingRoomId.value, pendingKind.value);
      return;
    }
    await sendCallLink(pendingRoomId.value, option.provider);
  }

  function closePicker(): void {
    pickerOpen.value = false;
  }

  return { pickerOpen, pickerOptions, pickerAnchor, launch, pick, closePicker };
}
