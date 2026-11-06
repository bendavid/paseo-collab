import { afterEach, describe, expect, it } from "vitest";
import type { AgentFeed, FeedEvent } from "../server/agent-feed";
import { snapshotBatches } from "../server/guest-session";
import { LinkManager } from "../server/links";
import type { GuestItem } from "../shared/guest-protocol";
import { type FakeRelay, startFakeRelay } from "./fake-relay";
import { connectGuest } from "./guest-client";

/** Stands in for an agent: fixed history, live events on demand, prompts recorded. */
function fakeFeed(history: GuestItem[]) {
  const listeners = new Set<(event: FeedEvent) => void>();
  const prompts: { text: string; sender: string }[] = [];
  const feed: AgentFeed = {
    describe: async () => ({
      title: "Fix the parser",
      provider: "claude",
      status: "idle",
      pendingApprovals: [],
    }),
    history: async () => history,
    subscribe: async (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send: async (text, sender) => {
      prompts.push({ text, sender });
    },
  };
  return {
    feed,
    prompts,
    emit: (event: FeedEvent) => listeners.forEach((listener) => listener(event)),
    subscribers: () => listeners.size,
  };
}

const PAGE = "https://guest.example/collab/";
const SECRET_TEXT = "the parser drops trailing commas";
let relay: FakeRelay;
let manager: LinkManager;

async function setup(): Promise<void> {
  relay = await startFakeRelay();
  manager = new LinkManager({
    relay: { endpoint: relay.endpoint, useTls: false },
    guestPageUrl: PAGE,
  });
}

afterEach(async () => {
  await manager?.stopAll();
  await relay?.close();
});

describe("collaboration links through the relay", () => {
  it("delivers the timeline only as ciphertext and forwards guest prompts", async () => {
    await setup();
    const agent = fakeFeed([{ type: "user_message", text: SECRET_TEXT }]);
    const link = await manager.create({
      agentId: "a1",
      allowPrompts: true,
      includeCode: false,
      feed: agent.feed,
    });

    expect(link.url).toMatch(
      /^https:\/\/guest\.example\/collab\/#v=1&relay=127\.0\.0\.1%3A\d+&tls=0&id=srv_[\w-]{12}&k=[\w-]+&s=[\w-]+$/,
    );
    const guest = await connectGuest({ url: link.url });

    expect(await guest.next((m) => m.type === "welcome")).toEqual({
      type: "welcome",
      agent: { title: "Fix the parser", provider: "claude", status: "idle", pendingApprovals: [] },
      allowPrompts: true,
      includeCode: false,
      guestName: "Guest 1",
    });
    expect(await guest.next((m) => m.type === "snapshot")).toEqual({
      type: "snapshot",
      items: [{ type: "user_message", text: SECRET_TEXT }],
    });

    agent.emit({ type: "item", item: { type: "assistant_message", text: "Looking now" } });
    await guest.next((m) => m.type === "item");
    await guest.send({ type: "prompt", text: "  Also handle tabs  " });
    await expect
      .poll(() => agent.prompts)
      .toEqual([{ text: "Also handle tabs", sender: "Guest 1" }]);

    const seenByRelay = relay.frames.join("");
    expect(relay.frames.length).toBeGreaterThan(3);
    for (const plaintext of [SECRET_TEXT, "Looking now", "Also handle tabs", "Guest 1"]) {
      expect(seenByRelay).not.toContain(plaintext);
    }
    expect(manager.list("a1")[0]?.guests).toBe(1);
  });

  it("refuses prompts on a view-only link", async () => {
    await setup();
    const agent = fakeFeed([]);
    const link = await manager.create({
      agentId: "a1",
      allowPrompts: false,
      includeCode: false,
      feed: agent.feed,
    });
    const guest = await connectGuest({ url: link.url });
    await guest.next((m) => m.type === "snapshot");

    await guest.send({ type: "prompt", text: "rm -rf /" });

    expect(await guest.next((m) => m.type === "prompt_rejected")).toEqual({
      type: "prompt_rejected",
      reason: "This link is view-only.",
    });
    expect(agent.prompts).toEqual([]);
  });

  it("tells a guest with the wrong secret why, then closes, sending nothing else", async () => {
    await setup();
    const agent = fakeFeed([{ type: "user_message", text: SECRET_TEXT }]);
    const link = await manager.create({
      agentId: "a1",
      allowPrompts: true,
      includeCode: false,
      feed: agent.feed,
    });

    const guest = await connectGuest({ url: link.url, secret: "guessed" });

    await guest.closed;
    expect(guest.messages).toEqual([{ type: "closing", code: 4401, reason: "invalid invitation" }]);
    expect(agent.subscribers()).toBe(0);
  });

  it("reuses the agent's live link and tells guests when it stops", async () => {
    await setup();
    const agent = fakeFeed([]);
    const link = await manager.create({
      agentId: "a1",
      allowPrompts: true,
      includeCode: false,
      feed: agent.feed,
    });
    const again = await manager.create({
      agentId: "a1",
      allowPrompts: false,
      includeCode: false,
      feed: agent.feed,
    });
    expect(again.linkId).toBe(link.linkId);

    const guest = await connectGuest({ url: link.url });
    await guest.next((m) => m.type === "snapshot");
    expect(await manager.stop(link.linkId)).toBe(true);

    expect(await guest.next((m) => m.type === "closing")).toEqual({
      type: "closing",
      code: 4410,
      reason: "link stopped",
    });
    await guest.closed;
    expect(manager.list()).toEqual([]);
    expect(agent.subscribers()).toBe(0);
  });

  it("fails link creation when the relay cannot be reached", async () => {
    relay = await startFakeRelay();
    const { endpoint } = relay;
    await relay.close();
    manager = new LinkManager({
      relay: { endpoint, useTls: false },
      guestPageUrl: PAGE,
      registrationTimeoutMs: 1_500,
    });

    await expect(
      manager.create({
        agentId: "a1",
        allowPrompts: true,
        includeCode: false,
        feed: fakeFeed([]).feed,
      }),
    ).rejects.toThrow(/Could not register with the relay/);
  });
});

describe("snapshot batches", () => {
  it("keeps every message under the batch size and loses nothing", () => {
    const big = "x".repeat(400 * 1024);
    const items: GuestItem[] = Array.from({ length: 6 }, (_, i) => ({
      type: "assistant_message",
      text: `${i}${big}`,
    }));

    const batches = snapshotBatches(items);

    expect(batches.map((batch) => batch.length)).toEqual([2, 2, 2]);
    expect(batches.flat()).toEqual(items);
    expect(snapshotBatches([])).toEqual([[]]);
  });
});
