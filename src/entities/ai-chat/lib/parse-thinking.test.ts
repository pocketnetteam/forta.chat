import { describe, it, expect } from "vitest";
import { parseThinking } from "./parse-thinking";

describe("parseThinking()", () => {
  it("returns the text unchanged as the answer when there is no <think> tag", () => {
    const result = parseThinking("Привет!");
    expect(result).toEqual({ thinking: null, isThinking: false, answer: "Привет!" });
  });

  it("splits a closed <think> block into thinking + answer", () => {
    const result = parseThinking("<think>\nOkay, thinking...\n</think>\n\nПривет!");
    expect(result).toEqual({ thinking: "Okay, thinking...", isThinking: false, answer: "Привет!" });
  });

  it("drops an empty <think></think> block entirely (thinking: null)", () => {
    const result = parseThinking("<think>\n</think>\n\nПривет!");
    expect(result).toEqual({ thinking: null, isThinking: false, answer: "Привет!" });
  });

  it("mid-stream: an unclosed <think> tag reports isThinking: true with no answer yet", () => {
    const result = parseThinking("<think>\nOkay, the user just said");
    expect(result).toEqual({ thinking: "Okay, the user just said", isThinking: true, answer: "" });
  });

  it("mid-stream: an unclosed <think> tag with nothing after it yet reports thinking: null", () => {
    const result = parseThinking("<think>");
    expect(result).toEqual({ thinking: null, isThinking: true, answer: "" });
  });

  it("streams past the closing tag: isThinking flips to false once </think> arrives, revealing the answer as it grows", () => {
    const midStream = parseThinking("<think>reasoning</think>Привет");
    expect(midStream).toEqual({ thinking: "reasoning", isThinking: false, answer: "Привет" });

    const moreStream = parseThinking("<think>reasoning</think>Привет! Как дела?");
    expect(moreStream).toEqual({ thinking: "reasoning", isThinking: false, answer: "Привет! Как дела?" });
  });

  it("preserves text before the <think> tag as part of the answer", () => {
    const result = parseThinking("lead-in <think>reasoning</think> trailing");
    expect(result).toEqual({ thinking: "reasoning", isThinking: false, answer: "lead-in  trailing" });
  });
});
