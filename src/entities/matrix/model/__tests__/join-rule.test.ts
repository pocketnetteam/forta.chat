import { describe, it, expect } from "vitest";
import { readJoinRule } from "../matrix-kit";

// Build a minimal room stub that mimics matrix-js-sdk's currentState.getStateEvents API.
// The SDK exposes two shapes depending on arity:
//   getStateEvents(type, stateKey)  → single MatrixEvent | null
//   getStateEvents(type)            → MatrixEvent[]
function roomWithSingleEvent(joinRule: string): Record<string, unknown> {
  return {
    currentState: {
      getStateEvents: (type: string, stateKey?: string) => {
        if (type !== "m.room.join_rules") return stateKey !== undefined ? null : [];
        if (stateKey === "") {
          return { getContent: () => ({ join_rule: joinRule }) };
        }
        return [{ event: { content: { join_rule: joinRule } } }];
      },
    },
  };
}

function roomWithArrayOnly(joinRule: string): Record<string, unknown> {
  // Some SDK versions only populate the arity-1 call and return an array where
  // items expose their content via `event.content`.
  return {
    currentState: {
      getStateEvents: (type: string, stateKey?: string) => {
        if (type !== "m.room.join_rules") return stateKey !== undefined ? null : [];
        if (stateKey === "") return null;
        return [{ event: { content: { join_rule: joinRule } } }];
      },
    },
  };
}

function roomWithoutJoinRules(): Record<string, unknown> {
  return {
    currentState: {
      getStateEvents: () => null,
    },
  };
}

describe("readJoinRule (single source of truth)", () => {
  it("returns 'public' when join_rule state event is public (arity-2 shape)", () => {
    expect(readJoinRule(roomWithSingleEvent("public"))).toBe("public");
  });

  it("returns 'invite' when join_rule state event is invite", () => {
    expect(readJoinRule(roomWithSingleEvent("invite"))).toBe("invite");
  });

  it("returns 'invite' by default when no state event present", () => {
    expect(readJoinRule(roomWithoutJoinRules())).toBe("invite");
  });

  it("returns 'invite' when room shape is missing currentState", () => {
    expect(readJoinRule({})).toBe("invite");
  });

  it("falls back to array shape when arity-2 returns null (SDK quirk)", () => {
    expect(readJoinRule(roomWithArrayOnly("public"))).toBe("public");
  });

  it("returns 'invite' if array is empty", () => {
    const room = {
      currentState: {
        getStateEvents: () => [],
      },
    };
    expect(readJoinRule(room)).toBe("invite");
  });

  it("handles getStateEvents throwing without crashing", () => {
    const room = {
      currentState: {
        getStateEvents: () => {
          throw new Error("boom");
        },
      },
    };
    expect(readJoinRule(room)).toBe("invite");
  });

  it("supports 'knock' and 'restricted' rules verbatim", () => {
    expect(readJoinRule(roomWithSingleEvent("knock"))).toBe("knock");
    expect(readJoinRule(roomWithSingleEvent("restricted"))).toBe("restricted");
  });
});
