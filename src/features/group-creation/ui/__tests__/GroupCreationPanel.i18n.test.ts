import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { ref, computed } from "vue";

let currentDict: Record<string, string> = {};

vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const text = currentDict[key] ?? key;
      if (!params) return text;
      return Object.entries(params).reduce(
        (acc, [k, v]) => acc.replace(new RegExp(`\\{${k}\\}`, "g"), String(v)),
        text,
      );
    },
    locale: { value: "ru" },
  }),
}));

const stubGroupCreation = (overrides: Partial<Record<string, unknown>> = {}) => ({
  step: ref<1 | 2>(1),
  selectedMembers: ref(new Map()),
  selectedMembersList: computed(() => [] as Array<{ address: string; name: string; image: string }>),
  groupName: ref(""),
  groupAvatarPreview: ref<string | null>(null),
  isCreating: ref(false),
  error: ref<string | null>(null),
  searchQuery: ref(""),
  searchResults: ref([] as Array<{ address: string; name: string; image: string }>),
  isSearching: ref(false),
  debouncedSearch: vi.fn(),
  toggleMember: vi.fn(),
  isMemberSelected: vi.fn(() => false),
  removeMember: vi.fn(),
  setAvatarFile: vi.fn(),
  goToStep2: vi.fn(),
  goToStep1: vi.fn(),
  createGroup: vi.fn(),
  reset: vi.fn(),
  ...overrides,
});

let mockState: ReturnType<typeof stubGroupCreation>;

vi.mock("../../model/use-group-creation", () => ({
  useGroupCreation: () => mockState,
}));

// UserAvatar and Avatar are auto-imported globals; stub via mocks so
// the GroupCreationPanel test stays focused on text content.
vi.mock("@/entities/user", () => ({
  UserAvatar: { name: "UserAvatar", template: '<div class="mock-avatar" />' },
}));
vi.mock("@/shared/ui/avatar/Avatar.vue", () => ({
  default: { name: "Avatar", template: '<div class="mock-avatar" />' },
}));

const RU: Record<string, string> = {
  "group.newGroup": "Новая группа",
  "group.next": "Далее",
  "group.searchUsers": "Поиск пользователей...",
  "group.noUsersFound": "Пользователи не найдены",
  "group.searchToAdd": "Найдите пользователей для добавления в группу",
  "group.groupName": "Название группы",
  "group.creating": "Создание...",
  "group.create": "Создать",
  "group.memberCount": "{count} участн.",
};

let GroupCreationPanel: typeof import("../GroupCreationPanel.vue").default;

describe("GroupCreationPanel i18n (WEE-30)", () => {
  beforeEach(async () => {
    currentDict = RU;
    mockState = stubGroupCreation();
    GroupCreationPanel = (await import("../GroupCreationPanel.vue")).default;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("step 1: renders Russian header and Next button in ru locale", () => {
    const w = mount(GroupCreationPanel);
    const text = w.text();
    expect(text).toContain("Новая группа");
    expect(text).toContain("Далее");
    // No hardcoded English remnants:
    expect(text).not.toContain("New Group");
    expect(text).not.toMatch(/\bNext\b/);
  });

  it("step 1: shows translated empty-search hint", () => {
    const w = mount(GroupCreationPanel);
    const text = w.text();
    expect(text).toContain("Найдите пользователей для добавления в группу");
    expect(text).not.toContain("Search for users to add to the group");
  });

  it("step 1: shows translated 'no users found' when query is non-empty", async () => {
    mockState.searchQuery.value = "abc";
    const w = mount(GroupCreationPanel);
    const text = w.text();
    expect(text).toContain("Пользователи не найдены");
    expect(text).not.toContain("No users found");
  });

  it("step 2: shows translated header and Create button when not creating", async () => {
    mockState.step.value = 2;
    mockState.groupName.value = "Test";
    const w = mount(GroupCreationPanel);
    const text = w.text();
    expect(text).toContain("Новая группа");
    expect(text).toContain("Создать");
    expect(text).not.toContain("Create Group");
    expect(text).not.toMatch(/\bCreate\b/);
  });

  it("step 2: shows translated 'Creating...' while isCreating=true", async () => {
    mockState.step.value = 2;
    mockState.groupName.value = "Test";
    mockState.isCreating.value = true;
    const w = mount(GroupCreationPanel);
    const text = w.text();
    expect(text).toContain("Создание...");
    expect(text).not.toContain("Creating...");
  });

  it("step 2: member count uses i18n key (no '1 member' / '2 members' English)", async () => {
    mockState.step.value = 2;
    mockState.groupName.value = "Test";
    mockState.selectedMembers.value = new Map([
      ["addr1", { address: "addr1", name: "Alice", image: "" }],
      ["addr2", { address: "addr2", name: "Bob", image: "" }],
    ]);
    const w = mount(GroupCreationPanel);
    const text = w.text();
    expect(text).toContain("2 участн.");
    expect(text).not.toMatch(/\b2 members?\b/);
  });
});
