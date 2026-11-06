// Runs a link against a real Paseo relay. Opt in with the relay's host:port, for example Paseo's
// own relay run locally from packages/relay:
//   wrangler dev --local --port 18787 --var PASEO_RELAY_UPSTREAM:
//   PASEO_COLLAB_RELAY_E2E=127.0.0.1:18787 npx vitest run test/relay.e2e.test.ts
// Set PASEO_COLLAB_RELAY_E2E_TLS=1 for a relay behind TLS.
import { afterEach, describe, expect, it } from "vitest";
import type { AgentFeed, FeedEvent } from "../server/agent-feed";
import { LinkManager } from "../server/links";
import type { GuestItem } from "../shared/guest-protocol";
import { connectGuest } from "./guest-client";

const endpoint = process.env.PASEO_COLLAB_RELAY_E2E;

function fakeFeed(history: GuestItem[]) {
  const listeners = new Set<(event: FeedEvent) => void>();
  const prompts: string[] = [];
  const feed: AgentFeed = {
    describe: async () => ({
      title: "Relay",
      provider: "claude",
      status: "idle",
      pendingApprovals: [],
    }),
    history: async () => history,
    subscribe: async (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send: async (text) => {
      prompts.push(text);
    },
  };
  return { feed, prompts, emit: (event: FeedEvent) => listeners.forEach((l) => l(event)) };
}

let manager: LinkManager | null = null;
afterEach(async () => {
  await manager?.stopAll();
});

describe.skipIf(!endpoint)("links through a real relay", () => {
  it("connects guests, relays both directions, and closes with an in-band reason", async () => {
    manager = new LinkManager({
      relay: { endpoint: endpoint!, useTls: process.env.PASEO_COLLAB_RELAY_E2E_TLS === "1" },
      guestPageUrl: "https://guest.example/",
    });
    const big = "y".repeat(1500 * 1024);
    const agent = fakeFeed([
      { type: "user_message", text: "first" },
      { type: "assistant_message", text: big },
      { type: "assistant_message", text: "last" },
    ]);
    const link = await manager.create({
      agentId: "a1",
      allowPrompts: true,
      feed: agent.feed,
    });

    const first = await connectGuest({ url: link.url });
    const second = await connectGuest({ url: link.url });
    for (const guest of [first, second]) {
      // The 1.5 MB row exceeds one batch, so the snapshot arrives as three messages.
      await expect
        .poll(() =>
          guest.messages
            .flatMap((m) => (m.type === "snapshot" || m.type === "snapshot_more" ? m.items : []))
            .map((item) => (item.type === "assistant_message" ? item.text.length : item.type)),
        )
        .toEqual(["user_message", big.length, 4]);
    }

    agent.emit({ type: "item", item: { type: "assistant_message", text: "live" } });
    await first.next((m) => m.type === "item");
    await second.next((m) => m.type === "item");
    await second.send({ type: "prompt", text: "from the second guest" });
    await expect.poll(() => agent.prompts).toEqual(["from the second guest"]);
    expect(manager.list()[0]?.guests).toBe(2);

    first.close();
    await expect.poll(() => manager?.list()[0]?.guests).toBe(1);

    await manager.stop(link.linkId);
    expect(await second.next((m) => m.type === "closing")).toMatchObject({ code: 4410 });
    await second.closed;
  }, 60_000);
});
