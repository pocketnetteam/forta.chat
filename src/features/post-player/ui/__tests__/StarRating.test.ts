import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import StarRating from "../StarRating.vue";

const FILL_GOLD = "fill-color-star-yellow";
const TEXT_GOLD = "text-color-star-yellow";
const NO_FILL = "fill-none";

const stars = (w: ReturnType<typeof mount>) => w.findAll("svg");

describe("StarRating three-state visual", () => {
  it("0 votes (totalVotes=0, modelValue=null) → all stars empty grey", () => {
    const w = mount(StarRating, {
      props: { average: 0, totalVotes: 0, modelValue: null },
    });
    const svgs = stars(w);
    expect(svgs).toHaveLength(5);
    svgs.forEach((s) => {
      expect(s.classes()).toContain(NO_FILL);
      expect(s.classes()).not.toContain(TEXT_GOLD);
      expect(s.classes()).not.toContain(FILL_GOLD);
    });
  });

  it("average=5 totalVotes=1 modelValue=null → 5 OUTLINE gold (no fill)", () => {
    const w = mount(StarRating, {
      props: { average: 5, totalVotes: 1, modelValue: null },
    });
    stars(w).forEach((s) => {
      expect(s.classes()).toContain(NO_FILL);
      expect(s.classes()).toContain(TEXT_GOLD);
      expect(s.classes()).not.toContain(FILL_GOLD);
    });
  });

  it("average=3.4 totalVotes=4 modelValue=null → first 3 outline gold, last 2 grey", () => {
    const w = mount(StarRating, {
      props: { average: 3.4, totalVotes: 4, modelValue: null },
    });
    const svgs = stars(w);
    [0, 1, 2].forEach((i) => {
      expect(svgs[i].classes()).toContain(NO_FILL);
      expect(svgs[i].classes()).toContain(TEXT_GOLD);
    });
    [3, 4].forEach((i) => {
      expect(svgs[i].classes()).toContain(NO_FILL);
      expect(svgs[i].classes()).not.toContain(TEXT_GOLD);
    });
  });

  it("average=3.5 rounds half-up → 4 outline gold (matches '3.5' label)", () => {
    const w = mount(StarRating, {
      props: { average: 3.5, totalVotes: 4, modelValue: null },
    });
    const svgs = stars(w);
    [0, 1, 2, 3].forEach((i) => {
      expect(svgs[i].classes()).toContain(NO_FILL);
      expect(svgs[i].classes()).toContain(TEXT_GOLD);
    });
    expect(svgs[4].classes()).not.toContain(TEXT_GOLD);
  });

  it("average=4.99 rounds to 5 outline gold (matches '5.0' label, not 4 / mismatch)", () => {
    // Real-world bug: average 4.99 was rendering as label "5.0" but only 4 outline stars
    const w = mount(StarRating, {
      props: { average: 4.99, totalVotes: 100, modelValue: null },
    });
    stars(w).forEach((s) => {
      expect(s.classes()).toContain(NO_FILL);
      expect(s.classes()).toContain(TEXT_GOLD);
    });
    expect(w.text()).toContain("5.0");
  });

  it("modelValue=4 (I voted) → first 4 FILLED gold, last 1 grey", () => {
    const w = mount(StarRating, {
      props: { average: 4.5, totalVotes: 10, modelValue: 4 },
    });
    const svgs = stars(w);
    [0, 1, 2, 3].forEach((i) => {
      expect(svgs[i].classes()).toContain(FILL_GOLD);
      expect(svgs[i].classes()).toContain(TEXT_GOLD);
    });
    expect(svgs[4].classes()).toContain(NO_FILL);
    expect(svgs[4].classes()).not.toContain(TEXT_GOLD);
  });

  it("modelValue=5 + average=5 → 5 FILLED (my vote dominates)", () => {
    const w = mount(StarRating, {
      props: { average: 5, totalVotes: 2, modelValue: 5 },
    });
    stars(w).forEach((s) => {
      expect(s.classes()).toContain(FILL_GOLD);
      expect(s.classes()).toContain(TEXT_GOLD);
    });
  });

  it("hover preview when interactive (not voted, not readonly)", async () => {
    const w = mount(StarRating, {
      props: { average: 2, totalVotes: 5, modelValue: null, readonly: false },
    });
    await stars(w)[4].trigger("mouseenter");
    const svgs = stars(w);
    [0, 1, 2, 3, 4].forEach((i) => {
      expect(svgs[i].classes()).toContain(FILL_GOLD);
      expect(svgs[i].classes()).toContain(TEXT_GOLD);
    });
  });

  it("hover does NOT trigger when readonly", async () => {
    const w = mount(StarRating, {
      props: { average: 5, totalVotes: 2, modelValue: 5, readonly: true },
    });
    await stars(w)[2].trigger("mouseenter");
    const svgs = stars(w);
    // Should still show MY VOTE (5 filled) — hover ignored
    [0, 1, 2, 3, 4].forEach((i) => {
      expect(svgs[i].classes()).toContain(FILL_GOLD);
    });
  });

  it("hover does NOT trigger after I voted (1-vote-per-user)", async () => {
    const w = mount(StarRating, {
      props: { average: 4, totalVotes: 5, modelValue: 3, readonly: false },
    });
    await stars(w)[4].trigger("mouseenter");
    const svgs = stars(w);
    // Star 4-5 should remain unfilled — hover preview suppressed
    expect(svgs[3].classes()).not.toContain(FILL_GOLD);
    expect(svgs[4].classes()).not.toContain(FILL_GOLD);
    // First 3 still filled (my vote)
    expect(svgs[0].classes()).toContain(FILL_GOLD);
  });

  it("emits update:modelValue on click when interactive", async () => {
    const w = mount(StarRating, {
      props: { average: 0, totalVotes: 0, modelValue: null, readonly: false },
    });
    await stars(w)[3].trigger("click");
    expect(w.emitted("update:modelValue")?.[0]).toEqual([4]);
  });

  it("does NOT emit when readonly", async () => {
    const w = mount(StarRating, {
      props: { average: 5, totalVotes: 5, modelValue: null, readonly: true },
    });
    await stars(w)[2].trigger("click");
    expect(w.emitted("update:modelValue")).toBeUndefined();
  });

  it("does NOT emit second time after I voted", async () => {
    const w = mount(StarRating, {
      props: { average: 4, totalVotes: 3, modelValue: 4, readonly: false },
    });
    await stars(w)[1].trigger("click");
    expect(w.emitted("update:modelValue")).toBeUndefined();
  });

  it("does NOT emit while submitting", async () => {
    const w = mount(StarRating, {
      props: { average: 0, totalVotes: 0, modelValue: null, submitting: true },
    });
    await stars(w)[2].trigger("click");
    expect(w.emitted("update:modelValue")).toBeUndefined();
  });

  it("shows numeric label by default when totalVotes > 0", () => {
    const w = mount(StarRating, {
      props: { average: 4.7, totalVotes: 3, modelValue: null },
    });
    expect(w.text()).toContain("4.7");
  });

  it("shows '0.0' when totalVotes is 0", () => {
    const w = mount(StarRating, {
      props: { average: 0, totalVotes: 0, modelValue: null },
    });
    expect(w.text()).toContain("0.0");
  });

  it("hides label when hideLabel=true", () => {
    const w = mount(StarRating, {
      props: { average: 4.5, totalVotes: 5, modelValue: null, hideLabel: true },
    });
    expect(w.text()).not.toContain("4.5");
  });

  it("compact mode renders smaller stars", () => {
    const w = mount(StarRating, {
      props: { average: 5, totalVotes: 1, modelValue: null, compact: true },
    });
    const svg = stars(w)[0];
    expect(svg.attributes("width")).toBe("12");
    expect(svg.attributes("height")).toBe("12");
  });
});
