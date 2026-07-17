import { describe, it, expect, beforeEach, vi } from "vitest";
import { ref, nextTick } from "vue";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { useMentionAutocomplete } from "../use-mention-autocomplete";
import { useChatStore } from "@/entities/chat";
import { useAuthStore } from "@/entities/auth";
import { useUserStore } from "@/entities/user/model";
import { hexEncode } from "@/shared/lib/matrix/functions";

/**
 * WEE-39 follow-up: when the sender renamed a contact locally ("qqq"),
 * the `@mention` payload sent to the room MUST carry the CANONICAL name
 * (the name peers share), not the private alias. Otherwise recipients see
 * an `@hexId:qqq` pill whose safeName does not match their own copy of
 * the contact and the pill renders as a stranger string.
 *
 * `displayMention` (what the sender sees in their input) may still use
 * the alias — that is the desired UX. Only `resolveText()`, which
 * materialises the wire payload, must canonicalise.
 */

function makeTextarea(initial = ""): HTMLTextAreaElement {
  const el = document.createElement("textarea");
  el.value = initial;
  el.selectionStart = initial.length;
  el.selectionEnd = initial.length;
  return el;
}

describe("useMentionAutocomplete — alias-free wire payload (WEE-39 follow-up)", () => {
  let chatStore: ReturnType<typeof useChatStore>;
  let authStore: ReturnType<typeof useAuthStore>;
  let userStore: ReturnType<typeof useUserStore>;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setActivePinia(createTestingPinia({ stubActions: false }));
    chatStore = useChatStore();
    authStore = useAuthStore();
    userStore = useUserStore();
    (authStore as unknown as { address: string }).address = "PSender";
  });

  function seedCanonical(address: string, name: string): void {
    userStore.setUser(address, {
      address,
      name,
      about: "",
      image: "",
      site: "",
      language: "",
    });
  }

  it("resolveText emits canonical name when sender has a local alias for the target", async () => {
    const targetRaw = "PTarget";
    const targetHex = hexEncode(targetRaw);

    // Sender's private rename: "qqq". Canonical name peers know: "dqwewr".
    chatStore.localAliases[targetRaw] = "qqq";
    seedCanonical(targetRaw, "dqwewr");

    const text = ref("hi @");
    const textareaRef = ref<HTMLTextAreaElement | undefined>(makeTextarea("hi @"));
    const mention = useMentionAutocomplete(text, textareaRef);

    textareaRef.value!.selectionStart = 4;
    textareaRef.value!.selectionEnd = 4;
    mention.onCursorChange();
    await nextTick();

    mention.insertMention(targetHex);
    await nextTick();

    // Sender's textarea pill keeps the familiar alias.
    expect(text.value).toBe("hi @qqq ");

    // Wire payload sent to peers MUST carry the canonical safeName.
    const wire = mention.resolveText();
    expect(wire).toBe(`hi @${targetHex}:dqwewr `);
    expect(wire).not.toContain(":qqq");
  });

  it("resolveText leaves canonical name unchanged when no alias is set", async () => {
    const targetRaw = "PNoAlias";
    const targetHex = hexEncode(targetRaw);
    seedCanonical(targetRaw, "Alice");

    const text = ref("@");
    const textareaRef = ref<HTMLTextAreaElement | undefined>(makeTextarea("@"));
    const mention = useMentionAutocomplete(text, textareaRef);

    textareaRef.value!.selectionStart = 1;
    textareaRef.value!.selectionEnd = 1;
    mention.onCursorChange();
    await nextTick();

    mention.insertMention(targetHex);
    await nextTick();

    expect(text.value).toBe("@Alice ");
    expect(mention.resolveText()).toBe(`@${targetHex}:Alice `);
  });
});
