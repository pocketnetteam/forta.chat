import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { nextTick, ref } from "vue";

// ───────────────── Mocks ─────────────────
// Shared reactive state — test can mutate these and component will react via watch
const userInfo = ref<
  | { name?: string; about?: string; site?: string; language?: string; image?: string }
  | undefined
>(undefined);
const isEditingUserData = ref(false);
const editUserDataMock = vi.fn();
const setUserMock = vi.fn();
const address = ref<string | undefined>("PAddrTestXXXXXXXXXXXXXXXXXXXXXXXX");

vi.mock("@/entities/auth", () => ({
  useAuthStore: () => ({
    get userInfo() { return userInfo.value; },
    get isEditingUserData() { return isEditingUserData.value; },
    get address() { return address.value; },
    editUserData: editUserDataMock,
  }),
}));

vi.mock("@/entities/user/model", () => ({
  useUserStore: () => ({
    setUser: setUserMock,
    getUser: () => undefined,
    loadUserIfMissing: vi.fn(),
  }),
}));

vi.mock("@/entities/locale", () => ({
  useLocaleStore: () => ({
    locale: "en",
    setLocale: vi.fn(),
  }),
}));

vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/shared/lib/upload-image", () => ({
  fileToBase64: vi.fn(async () => "data:image/png;base64,AAAA"),
  uploadImage: vi.fn(async () => "https://cdn.example/avatar.png"),
}));

vi.mock("@/shared/ui/avatar/Avatar.vue", () => ({
  default: { name: "Avatar", template: "<div class='avatar-stub' />" },
}));

// Spinner is auto-imported by unplugin — stub via globals in mount options
import UserEditForm from "../UserEditForm.vue";

function makeWrapper() {
  return mount(UserEditForm, {
    global: {
      stubs: { Spinner: { template: "<span />" } },
    },
  });
}

function resetState() {
  userInfo.value = undefined;
  isEditingUserData.value = false;
  address.value = "PAddrTestXXXXXXXXXXXXXXXXXXXXXXXX";
  editUserDataMock.mockReset();
  setUserMock.mockReset();
}

describe("UserEditForm — reactive form sync and hasChanges", () => {
  beforeEach(() => {
    resetState();
  });

  // ── Bug 1 + 2: userInfo undefined at mount ───────────────────

  it("enables Save when user types a name and userInfo is undefined", async () => {
    userInfo.value = undefined;
    const wrapper = makeWrapper();
    await nextTick();

    const nameInput = wrapper.find("input[type='text']");
    expect(nameInput.exists()).toBe(true);
    await nameInput.setValue("Alice");
    await nextTick();

    const saveBtn = wrapper.find("button[type='submit']");
    expect(saveBtn.attributes("disabled")).toBeUndefined();
  });

  it("treats any non-empty field as a change when userInfo is undefined (hasChanges=true)", async () => {
    userInfo.value = undefined;
    const wrapper = makeWrapper();
    await nextTick();

    const textarea = wrapper.find("textarea");
    await textarea.setValue("hello world");
    await nextTick();

    const saveBtn = wrapper.find("button[type='submit']");
    expect(saveBtn.attributes("disabled")).toBeUndefined();
  });

  // ── async userInfo load: populates form when user hasn't typed ──

  it("populates form fields when userInfo loads after mount (user hasn't typed)", async () => {
    userInfo.value = undefined;
    const wrapper = makeWrapper();
    await nextTick();

    // Simulate async userInfo arrival
    userInfo.value = {
      name: "Bob",
      about: "I like TS",
      site: "https://bob.dev",
      language: "en",
      image: "https://cdn.example/bob.png",
    };
    await nextTick();
    await flushPromises();

    const nameInput = wrapper.find("input[type='text']") as any;
    expect((nameInput.element as HTMLInputElement).value).toBe("Bob");

    const textarea = wrapper.find("textarea");
    expect((textarea.element as HTMLTextAreaElement).value).toBe("I like TS");

    // hasChanges must be false — form === userInfo
    const saveBtn = wrapper.find("button[type='submit']");
    expect(saveBtn.attributes("disabled")).toBeDefined();
  });

  // ── dirty flag: user input wins over late async userInfo ──

  it("preserves user input when userInfo loads asynchronously (user already typed)", async () => {
    userInfo.value = undefined;
    const wrapper = makeWrapper();
    await nextTick();

    const nameInput = wrapper.find("input[type='text']");
    await nameInput.setValue("Charlie");
    await nextTick();

    // late arrival of userInfo should NOT overwrite user input
    userInfo.value = { name: "Bob", about: "", site: "", language: "en" };
    await nextTick();
    await flushPromises();

    expect((nameInput.element as HTMLInputElement).value).toBe("Charlie");
    const saveBtn = wrapper.find("button[type='submit']");
    expect(saveBtn.attributes("disabled")).toBeUndefined();
  });

  // ── avatar uploading blocks Save ──

  it("disables Save button while avatar is uploading", async () => {
    userInfo.value = { name: "Bob", about: "", site: "", language: "en" };
    const wrapper = makeWrapper();
    await nextTick();

    // change name so hasChanges would otherwise be true
    const nameInput = wrapper.find("input[type='text']");
    await nameInput.setValue("Alice");
    await nextTick();
    expect(wrapper.find("button[type='submit']").attributes("disabled")).toBeUndefined();

    // Simulate avatar upload start via hanging uploadImage
    const { fileToBase64, uploadImage } = await import("@/shared/lib/upload-image");
    let resolveUpload: (v: string) => void = () => {};
    (uploadImage as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveUpload = resolve; })
    );
    (fileToBase64 as ReturnType<typeof vi.fn>).mockResolvedValueOnce("data:image/png;base64,AAAA");

    // Dispatch file change event directly on the hidden input
    const fileInput = wrapper.find("input[type='file']");
    const file = new File(["x"], "a.png", { type: "image/png" });
    Object.defineProperty(fileInput.element, "files", {
      value: [file],
      configurable: true,
    });
    await fileInput.trigger("change");
    await flushPromises();
    // upload still pending — button should be disabled
    expect(wrapper.find("button[type='submit']").attributes("disabled")).toBeDefined();

    // finish upload
    resolveUpload("https://cdn.example/newavatar.png");
    await flushPromises();
    expect(wrapper.find("button[type='submit']").attributes("disabled")).toBeUndefined();
  });

  // ── Bug 3: base64 avatar must not be sent to blockchain ──

  it("does not send base64 data: URL to editUserData (blockchain safety)", async () => {
    userInfo.value = { name: "Bob", about: "", site: "", language: "en", image: "" };
    const wrapper = makeWrapper();
    await nextTick();

    // Force avatar to remain base64 by making uploadImage hang forever, then
    // try to click Save — save must NOT call editUserData with base64 URL
    const { fileToBase64, uploadImage } = await import("@/shared/lib/upload-image");
    (uploadImage as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<string>(() => {})
    );
    (fileToBase64 as ReturnType<typeof vi.fn>).mockResolvedValueOnce("data:image/png;base64,AAAA");

    const fileInput = wrapper.find("input[type='file']");
    const file = new File(["x"], "a.png", { type: "image/png" });
    Object.defineProperty(fileInput.element, "files", {
      value: [file],
      configurable: true,
    });
    await fileInput.trigger("change");
    await flushPromises();

    // Button is disabled due to avatarUploading; attempt to submit the form programmatically
    await wrapper.find("form").trigger("submit.prevent");
    await flushPromises();

    // editUserData must not have been called OR, if called, NEVER with a data: URL
    for (const call of editUserDataMock.mock.calls) {
      const payload = call[0] as { image?: string };
      expect(payload.image ?? "").not.toMatch(/^data:/);
    }
  });

  // ── users with undefined userInfo CAN save (fallback shell) ──

  it("calls editUserData with a fallback profile shell when userInfo is undefined", async () => {
    userInfo.value = undefined;
    editUserDataMock.mockResolvedValue(undefined);
    const wrapper = makeWrapper();
    await nextTick();

    const nameInput = wrapper.find("input[type='text']");
    await nameInput.setValue("Alice");
    await nextTick();

    await wrapper.find("form").trigger("submit.prevent");
    await flushPromises();

    // With undefined userInfo, handleSave must still call editUserData using
    // an empty-profile fallback so users with broken registration are not
    // stuck forever. The payload must carry the user's new name + the
    // user's address (so the backend can create the profile).
    expect(editUserDataMock).toHaveBeenCalledTimes(1);
    const payload = editUserDataMock.mock.calls[0][0];
    expect(payload.name).toBe("Alice");
    expect(payload.address).toBe("PAddrTestXXXXXXXXXXXXXXXXXXXXXXXX");
  });

  // ── envelope error from editUserData surfaces to saveError ──

  it("surfaces saveError when editUserData returns { success: false }", async () => {
    userInfo.value = { name: "Bob", about: "", site: "", language: "en" };
    editUserDataMock.mockResolvedValue({ success: false, reason: "timeout" });
    const wrapper = makeWrapper();
    await nextTick();

    const nameInput = wrapper.find("input[type='text']");
    await nameInput.setValue("Alice");
    await nextTick();

    await wrapper.find("form").trigger("submit.prevent");
    await flushPromises();

    expect(editUserDataMock).toHaveBeenCalledTimes(1);
    expect((wrapper.vm as unknown as { saveError: string }).saveError)
      .toBeTruthy();
    // Success flag must NOT have flipped on
    expect((wrapper.vm as unknown as { saveSuccess: boolean }).saveSuccess)
      .toBe(false);
  });

  // ── happy path: save clean change ──

  it("calls editUserData with updated fields on successful save", async () => {
    userInfo.value = { name: "Bob", about: "old", site: "", language: "en", image: "" };
    editUserDataMock.mockResolvedValue(undefined);
    const wrapper = makeWrapper();
    await nextTick();

    const nameInput = wrapper.find("input[type='text']");
    await nameInput.setValue("Alice");
    await nextTick();

    await wrapper.find("form").trigger("submit.prevent");
    await flushPromises();

    expect(editUserDataMock).toHaveBeenCalledTimes(1);
    const payload = editUserDataMock.mock.calls[0][0];
    expect(payload.name).toBe("Alice");
    expect(payload.about).toBe("old");
  });
});
