import { describe, it, expect, beforeEach } from "vitest";
import { enqueue, dequeue, getQueue, clearQueue } from "./offline-queue";
import type { QueuedMessage } from "./offline-queue";

function makeQueueMsg(id: string): QueuedMessage {
  return { id, roomId: "!room:server", content: `msg-${id}`, timestamp: Date.now() };
}

describe("offline-queue", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns undefined when dequeuing from empty queue", () => {
    expect(dequeue()).toBeUndefined();
  });

  it("enqueues and dequeues a single message", () => {
    const msg = makeQueueMsg("1");
    enqueue(msg);
    const result = dequeue();
    expect(result).toEqual(msg);
  });

  it("preserves FIFO order", () => {
    enqueue(makeQueueMsg("a"));
    enqueue(makeQueueMsg("b"));
    enqueue(makeQueueMsg("c"));
    expect(dequeue()!.id).toBe("a");
    expect(dequeue()!.id).toBe("b");
    expect(dequeue()!.id).toBe("c");
    expect(dequeue()).toBeUndefined();
  });

  it("getQueue returns all queued messages", () => {
    enqueue(makeQueueMsg("1"));
    enqueue(makeQueueMsg("2"));
    const queue = getQueue();
    expect(queue).toHaveLength(2);
    expect(queue[0].id).toBe("1");
    expect(queue[1].id).toBe("2");
  });

  it("getQueue returns empty array for empty queue", () => {
    expect(getQueue()).toEqual([]);
  });

  it("clearQueue removes all messages", () => {
    enqueue(makeQueueMsg("1"));
    enqueue(makeQueueMsg("2"));
    clearQueue();
    expect(getQueue()).toEqual([]);
    expect(dequeue()).toBeUndefined();
  });

  it("dequeue removes only the first item", () => {
    enqueue(makeQueueMsg("x"));
    enqueue(makeQueueMsg("y"));
    dequeue();
    expect(getQueue()).toHaveLength(1);
    expect(getQueue()[0].id).toBe("y");
  });

  it("recovers from corrupted localStorage", () => {
    localStorage.setItem("bastyon-chat:offline-queue", "bad json!!!");
    expect(getQueue()).toEqual([]);
  });
});
