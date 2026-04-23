import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import PollCard from "../PollCard.vue";
import { MessageStatus, MessageType } from "@/entities/chat";
import type { Message } from "@/entities/chat";

vi.stubGlobal("useI18n", () => ({ t: (k: string) => k }));

function makePollMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "$poll1",
    roomId: "!room:server",
    senderId: "PSender1",
    content: "Favorite color?",
    timestamp: Date.now(),
    status: MessageStatus.sent,
    type: MessageType.poll,
    pollInfo: {
      question: "Favorite color?",
      options: [
        { id: "opt-0", text: "Red" },
        { id: "opt-1", text: "Blue" },
        { id: "opt-2", text: "Green" },
      ],
      votes: {},
    },
    ...overrides,
  } as Message;
}

describe("PollCard", () => {
  beforeEach(() => {
    vi.stubGlobal("useI18n", () => ({ t: (k: string) => k }));
  });

  it("emits vote with optionId when user clicks an option", async () => {
    const wrapper = mount(PollCard, {
      props: { message: makePollMessage(), isOwn: false },
    });

    await wrapper.findAll("button")[0].trigger("click");

    const voteEvents = wrapper.emitted("vote");
    expect(voteEvents).toBeTruthy();
    expect(voteEvents![0]).toEqual(["opt-0"]);
  });

  it("allows changing vote after user has already voted (MSC3381: last vote wins)", async () => {
    const msg = makePollMessage({
      pollInfo: {
        question: "Q",
        options: [
          { id: "opt-0", text: "A" },
          { id: "opt-1", text: "B" },
        ],
        votes: { "opt-0": ["PMe"] },
        myVote: "opt-0",
      },
    });
    const wrapper = mount(PollCard, {
      props: { message: msg, isOwn: false },
    });

    const buttons = wrapper.findAll("button");
    await buttons[1].trigger("click");

    const voteEvents = wrapper.emitted("vote");
    expect(voteEvents).toBeTruthy();
    expect(voteEvents![0]).toEqual(["opt-1"]);
  });

  it("blocks voting when poll is ended", async () => {
    const msg = makePollMessage({
      pollInfo: {
        question: "Q",
        options: [
          { id: "opt-0", text: "A" },
          { id: "opt-1", text: "B" },
        ],
        votes: { "opt-0": ["PSomeone"] },
        ended: true,
      },
    });
    const wrapper = mount(PollCard, {
      props: { message: msg, isOwn: false },
    });

    await wrapper.findAll("button")[0].trigger("click");

    expect(wrapper.emitted("vote")).toBeFalsy();
  });

  it("prevents double-fire from rapid duplicate clicks on the same option", async () => {
    const wrapper = mount(PollCard, {
      props: { message: makePollMessage(), isOwn: false },
    });
    const firstOption = wrapper.findAll("button")[0];

    await firstOption.trigger("click");
    await firstOption.trigger("click");
    await firstOption.trigger("click");

    const voteEvents = wrapper.emitted("vote");
    expect(voteEvents).toBeTruthy();
    expect(voteEvents!.length).toBe(1);
  });

  it("marks selected option with aria-pressed when user has voted", () => {
    const msg = makePollMessage({
      pollInfo: {
        question: "Q",
        options: [
          { id: "opt-0", text: "A" },
          { id: "opt-1", text: "B" },
        ],
        votes: { "opt-0": ["PMe"] },
        myVote: "opt-0",
      },
    });
    const wrapper = mount(PollCard, {
      props: { message: msg, isOwn: false },
    });

    const buttons = wrapper.findAll("button");
    expect(buttons[0].attributes("aria-pressed")).toBe("true");
    expect(buttons[1].attributes("aria-pressed")).toBe("false");
  });

  it("emits end when poll owner clicks End poll", async () => {
    const wrapper = mount(PollCard, {
      props: { message: makePollMessage(), isOwn: true },
    });

    const endButton = wrapper
      .findAll("button")
      .find(b => b.text().toLowerCase().includes("end poll"));
    expect(endButton).toBeDefined();

    await endButton!.trigger("click");
    expect(wrapper.emitted("end")).toBeTruthy();
  });
});
