import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { SharePopover } from "./share-popover";

/** Adds a Collab pill to every agent's composer, following the agent directory. */
export function addSharePills(client: PluginClientContext): () => void {
  const pills = new Map<string, PluginButtonRegistration>();
  const lifetime = new AbortController();

  function register(agent: { id: string; workspaceId?: string | null }) {
    if (lifetime.signal.aborted || !agent.workspaceId || pills.has(agent.id)) return;
    pills.set(
      agent.id,
      client.addComposerPill({
        id: "share-link",
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        button: {
          title: "Collaborate through a link",
          icon: "Share2",
          label: "Collab",
          behavior: { kind: "popover", Content: SharePopover },
        },
      }),
    );
  }

  function remove(agentId: string) {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
  }

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          const current = new Set(entries.map(({ agent }) => agent.id));
          for (const agentId of [...pills.keys()]) if (!current.has(agentId)) remove(agentId);
          for (const { agent } of entries) register(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          if (message.payload.kind === "remove") remove(message.payload.agentId);
          else register(message.payload.agent);
        },
      });
    })
    .catch((error) => {
      if (!lifetime.signal.aborted) console.error("Agent observation failed", error);
    });

  return () => {
    lifetime.abort();
    for (const pill of pills.values()) pill.remove();
    pills.clear();
  };
}
