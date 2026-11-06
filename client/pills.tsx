import type {
  PluginButtonIconProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { View } from "react-native";
import { listLinksRpc } from "../shared/links";
import {
  IDLE_PILL,
  onLinksChanged,
  type PillState,
  pillLabel,
  pillStates,
  pillTitle,
  samePillState,
} from "./pill-state";
import { SharePopover } from "./share-popover";

/**
 * How often pills re-read the host's links. The published SDK has no client subscription yet, so
 * the pill polls; one call covers every agent on the host.
 */
const POLL_MS = 3_000;

/** The pill's icon while a link is live: the same glyph on a filled success-colored badge. */
function ActiveIcon({ size, theme }: PluginButtonIconProps) {
  const badge = {
    width: size,
    height: size,
    borderRadius: size / 2,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    backgroundColor: theme.colors.statusSuccess,
  };
  return (
    <View style={badge}>
      <Icon name="Share2" size={Math.round(size * 0.62)} color={theme.colors.surface0} />
    </View>
  );
}

interface Pill {
  registration: PluginButtonRegistration;
  state: PillState;
}

function button(state: PillState) {
  return {
    title: pillTitle(state),
    icon: state.active ? ActiveIcon : "Share2",
    label: pillLabel(state),
  };
}

/** Adds a Collab pill to every agent's composer, following the agent directory. */
export function addSharePills(client: PluginClientContext): () => void {
  const pills = new Map<string, Pill>();
  const lifetime = new AbortController();
  let latest = new Map<string, PillState>();

  function apply(agentId: string, pill: Pill): void {
    const next = latest.get(agentId) ?? IDLE_PILL;
    if (samePillState(pill.state, next)) return;
    pill.state = next;
    // Only appearance changes: updating `behavior` would close an open popover.
    pill.registration.update(button(next));
  }

  function register(agent: { id: string; workspaceId?: string | null }) {
    if (lifetime.signal.aborted || !agent.workspaceId || pills.has(agent.id)) return;
    const state = latest.get(agent.id) ?? IDLE_PILL;
    pills.set(agent.id, {
      state,
      registration: client.addComposerPill({
        id: "share-link",
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        button: { ...button(state), behavior: { kind: "popover", Content: SharePopover } },
      }),
    });
  }

  function remove(agentId: string) {
    pills.get(agentId)?.registration.remove();
    pills.delete(agentId);
  }

  let refreshing = false;
  async function refresh(): Promise<void> {
    if (refreshing || lifetime.signal.aborted || pills.size === 0) return;
    refreshing = true;
    try {
      const { links } = await client.rpc(listLinksRpc, {});
      if (lifetime.signal.aborted) return;
      latest = pillStates(links);
      for (const [agentId, pill] of pills) apply(agentId, pill);
    } catch {
      // The daemon or plugin is unavailable; keep the last state and try again on the next tick.
    } finally {
      refreshing = false;
    }
  }

  const timer = setInterval(() => void refresh(), POLL_MS);
  const stopListening = onLinksChanged(() => void refresh());

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          const current = new Set(entries.map(({ agent }) => agent.id));
          for (const agentId of [...pills.keys()]) if (!current.has(agentId)) remove(agentId);
          for (const { agent } of entries) register(agent);
          void refresh();
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
    clearInterval(timer);
    stopListening();
    for (const pill of pills.values()) pill.registration.remove();
    pills.clear();
  };
}
