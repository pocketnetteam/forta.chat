import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * C06 review (2026-10-10): the call category carries `.defaultToSpeaker`, and
 * `.videoChat` mode routes to the loudspeaker by itself, so
 * `overrideOutputAudioPort(.none)` kept the audio on the loudspeaker and the
 * speaker toggle could not go back to the earpiece. Source-level: the Swift
 * plugin has no unit tests here; the route itself is checked on the iPhone
 * (docs/manual-verification.md, C06).
 */
const swift = readFileSync(resolve(__dirname, "../../../../ios/App/App/IOSCallAudioPlugin.swift"), "utf-8");

describe("IOSCallAudio.setOutput — earpiece", () => {
  it("leaves the loudspeaker default and video mode before dropping the override", () => {
    const branch = swift.slice(swift.indexOf('case "earpiece", "default":'), swift.indexOf("default:\n", swift.indexOf('case "earpiece", "default":')));
    const category = branch.indexOf("try session.setCategory(");
    const override = branch.indexOf("try session.overrideOutputAudioPort(.none)");
    expect(category).toBeGreaterThanOrEqual(0);
    expect(override).toBeGreaterThan(category);
    const call = branch.slice(category, override);
    expect(call).toContain("mode: .voiceChat");
    expect(call).toContain("Self.callOptions.subtracting(.defaultToSpeaker)");
  });

  it("a new call still starts with the call options, loudspeaker default included", () => {
    const start = swift.slice(swift.indexOf("@objc func start("), swift.indexOf("@objc func stop("));
    expect(start).toContain("options: Self.callOptions)");
    expect(swift).toMatch(/callOptions: AVAudioSession\.CategoryOptions = \[[\s\S]*?\.defaultToSpeaker,/);
  });
});
