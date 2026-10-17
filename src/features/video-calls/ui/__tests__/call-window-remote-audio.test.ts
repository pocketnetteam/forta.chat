import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression: the hidden element that plays the peer's audio sat inside
 * v-if="show", so minimizing a call removed it (silence) and the one created
 * on restore never got the stream again (web, iOS, Electron). It must live
 * outside the conditional call container.
 */
const source = readFileSync(resolve(__dirname, "../CallWindow.vue"), "utf-8");
const template = source.slice(source.indexOf("<template>"));

describe("CallWindow remote audio element", () => {
  it("is rendered outside the v-if call container", () => {
    const audioAt = template.indexOf('ref="remoteAudioRef"');
    const containerAt = template.indexOf('v-if="show"');
    expect(audioAt).toBeGreaterThan(-1);
    expect(containerAt).toBeGreaterThan(-1);
    expect(audioAt).toBeLessThan(containerAt);
  });
});
