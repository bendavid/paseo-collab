import { DEFAULT_RELAY_ENDPOINT } from "@getpaseo/protocol/daemon-endpoints";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createPaseoAgentFeed } from "./server/agent-feed";
import { LinkManager } from "./server/links";
import { createLinkRpc, listLinksRpc, stopLinkRpc } from "./shared/links";

/** Where guests load the page. It holds no session data; the link's fragment carries that. */
const DEFAULT_GUEST_PAGE_URL = "https://bendavid.github.io/paseo-collab-link/";

export default function contribute(server: PluginServerContext) {
  // Overrides for a self-hosted relay or page, and for development.
  const relayEndpoint = process.env.PASEO_COLLAB_RELAY ?? DEFAULT_RELAY_ENDPOINT;
  const links = new LinkManager({
    relay: { endpoint: relayEndpoint, useTls: process.env.PASEO_COLLAB_RELAY_TLS !== "0" },
    guestPageUrl: process.env.PASEO_COLLAB_GUEST_PAGE ?? DEFAULT_GUEST_PAGE_URL,
  });

  server.handle(createLinkRpc, async ({ agentId, allowPrompts }, { paseo }) => {
    const feed = createPaseoAgentFeed(paseo, agentId);
    // Fail before registering with the relay when the agent does not exist.
    await feed.describe();
    return links.create({ agentId, allowPrompts, feed });
  });
  server.handle(listLinksRpc, ({ agentId }) => ({ links: links.list(agentId) }));
  server.handle(stopLinkRpc, async ({ linkId }) => ({ stopped: await links.stop(linkId) }));

  return () => links.stopAll();
}
