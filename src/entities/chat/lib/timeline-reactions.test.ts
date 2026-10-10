import { describe, it, expect } from "vitest";
import { collectTimelineReactions } from "./timeline-reactions";

const reaction = (id: string, sender: string, target: string, key: string) => ({
  type: "m.reaction",
  event_id: id,
  sender,
  content: { "m.relates_to": { rel_type: "m.annotation", event_id: target, key } },
});

describe("collectTimelineReactions", () => {
  it("counts one vote per user per emoji and records my own event id", () => {
    const map = collectTimelineReactions(
      [
        reaction("$1", "@peer:s", "$m", "👍"),
        reaction("$2", "@peer:s", "$m", "👍"), // duplicate vote
        reaction("$3", "@me:s", "$m", "👍"),
        reaction("$4", "@peer:s", "$other", "🔥"),
      ],
      (id) => id === "@me:s",
    );

    const m = map.get("$m")!["👍"];
    expect(m.count).toBe(2);
    expect(m.users).toHaveLength(2);
    expect(m.myEventId).toBe("$3");
    expect(map.get("$other")!["🔥"].count).toBe(1);
  });

  it("skips redacted reactions (no relation left)", () => {
    const map = collectTimelineReactions([{ type: "m.reaction", event_id: "$x", sender: "@p:s", content: {} }], () => false);
    expect(map.size).toBe(0);
  });
});
