import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { ref, computed } from "vue";

vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: { value: "en" },
  }),
}));

type SelectedMember = { address: string; name: string; image: string };

const stubGroupCreation = (overrides: Partial<Record<string, unknown>> = {}) => ({
  step: ref<1 | 2>(1),
  selectedMembers: ref(new Map()),
  selectedMembersList: computed(() => [] as SelectedMember[]),
  groupName: ref(""),
  groupAvatarPreview: ref<string | null>(null),
  isCreating: ref(false),
  error: ref<string | null>(null),
  searchQuery: ref("alice"),
  searchResults: ref([
    { address: "addr1", name: "Alice", image: "" },
    { address: "addr2", name: "Bob", image: "" },
    { address: "addr3", name: "Carol", image: "" },
  ]),
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

vi.mock("@/entities/user", () => ({
  UserAvatar: { name: "UserAvatar", template: '<div class="mock-avatar" />' },
}));
vi.mock("@/shared/ui/avatar/Avatar.vue", () => ({
  default: { name: "Avatar", template: '<div class="mock-avatar" />' },
}));

let GroupCreationPanel: typeof import("../GroupCreationPanel.vue").default;

describe("GroupCreationPanel member list scroll", () => {
  beforeEach(async () => {
    mockState = stubGroupCreation();
    GroupCreationPanel = (await import("../GroupCreationPanel.vue")).default;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("step 1: member list is a constrained flex scroll region with hidden scrollbar", () => {
    const w = mount(GroupCreationPanel);
    const list = w.find('[data-testid="group-member-list"]');
    expect(list.exists()).toBe(true);

    const classes = list.classes();
    expect(classes).toContain("min-h-0");
    expect(classes).toContain("flex-1");
    expect(classes).toContain("overflow-y-auto");
    expect(classes).toContain("member-list-scroll");
  });

  it("root panel has min-h-0 and min-w-0 so the flex scroll chain can shrink", () => {
    const w = mount(GroupCreationPanel);
    expect(w.element.classList.contains("min-h-0")).toBe(true);
    expect(w.element.classList.contains("min-w-0")).toBe(true);
  });

  it("step 1: selected chips row is width-constrained with horizontal scroll", () => {
    const members: SelectedMember[] = [
      { address: "addr1", name: "Alice", image: "" },
      { address: "addr2", name: "Bob", image: "" },
      { address: "addr3", name: "Carol", image: "" },
      { address: "addr4", name: "Dave", image: "" },
    ];
    mockState = stubGroupCreation({
      selectedMembers: ref(
        new Map(members.map((m) => [m.address, m])),
      ),
      selectedMembersList: computed(() => members),
    });

    const w = mount(GroupCreationPanel);
    const chips = w.find('[data-testid="group-selected-chips"]');
    expect(chips.exists()).toBe(true);

    const classes = chips.classes();
    expect(classes).toContain("min-w-0");
    expect(classes).toContain("w-full");
    expect(classes).toContain("overflow-x-auto");
    expect(classes).toContain("member-list-scroll");
  });
});
