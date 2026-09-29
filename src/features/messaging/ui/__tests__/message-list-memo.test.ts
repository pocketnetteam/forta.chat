import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { defineComponent, nextTick, reactive, shallowRef } from "vue";
import { mount } from "@vue/test-utils";

/**
 * Regression: the message row's v-memo listed hand-picked fields and left out
 * `uploadProgress` (and `content`, `decryptionStatus`, `fileInfo`), so a row
 * never re-rendered while its file uploaded — the bubble sat at "0%" while the
 * store climbed to 95 % (Samsung, 2026-09-25) — and a message decrypted after
 * it first rendered kept showing the old text until its status changed. The
 * store hands a new Message object whenever any mapped field changes and the
 * same object otherwise (activeMessages' reuseIfUnchanged), so the memo keys
 * on that reference.
 *
 * The test renders a row with the v-memo expression read from MessageList.vue
 * itself, so it follows whatever the component does.
 */
const memoExpression = (): string => {
  const src = readFileSync(resolve(__dirname, "../MessageList.vue"), "utf-8");
  const match = src.match(/v-track-read\s+v-memo="([^"]+)"/);
  if (!match) throw new Error("message row v-memo not found in MessageList.vue");
  return match[1];
};

interface Row {
  id: string;
  message: Record<string, unknown>;
}

function mountRows(rows: Row[]) {
  const items = shallowRef(rows);
  const contextMenu = reactive({ show: false, message: null as { id: string } | null });
  const wrapper = mount(
    defineComponent({
      setup: () => ({ items, contextMenu }),
      template: `
        <div>
          <div v-for="item in items" :key="item.id">
            <div v-memo="${memoExpression()}">
              <span class="progress">{{ item.message.uploadProgress }}%</span>
              <span class="content">{{ item.message.content }}</span>
            </div>
          </div>
        </div>`,
    }),
  );
  return { wrapper, items };
}

const base = { timestamp: 1, deleted: false, reactions: undefined, pollInfo: undefined, edited: false, status: "sending" };

describe("MessageList row v-memo", () => {
  it("re-renders a row whose upload progress changed", async () => {
    const { wrapper, items } = mountRows([{ id: "m1", message: { ...base, id: "m1", uploadProgress: 0, content: "f" } }]);
    expect(wrapper.find(".progress").text()).toBe("0%");

    items.value = [{ id: "m1", message: { ...base, id: "m1", uploadProgress: 47, content: "f" } }];
    await nextTick();

    expect(wrapper.find(".progress").text()).toBe("47%");
  });

  it("re-renders a row whose text was decrypted after it first rendered", async () => {
    const { wrapper, items } = mountRows([{ id: "m1", message: { ...base, id: "m1", status: "sent", content: "[encrypted]" } }]);

    items.value = [{ id: "m1", message: { ...base, id: "m1", status: "sent", content: "hello" } }];
    await nextTick();

    expect(wrapper.find(".content").text()).toBe("hello");
  });

  it("skips a row whose message object is the same", async () => {
    const message = { ...base, id: "m1", uploadProgress: 10, content: "f" };
    const { wrapper, items } = mountRows([{ id: "m1", message }]);

    // Mutating in place without a new object is what the memo must ignore:
    // the store never does it, and a skipped render proves the memo still works.
    message.uploadProgress = 99;
    items.value = [{ id: "m1", message }];
    await nextTick();

    expect(wrapper.find(".progress").text()).toBe("10%");
  });
});
