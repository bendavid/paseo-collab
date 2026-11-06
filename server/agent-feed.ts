import { homedir } from "node:os";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { GuestAgent, GuestAgentStatus, GuestItem } from "../shared/guest-protocol";
import { formatGuestPrompt } from "./guest-envelope";
import { type ProjectionContext, toFeedEvent, toGuestItem } from "./guest-projection";

type PaseoApi = PluginHandlerContext["paseo"];
type AgentHandle = ReturnType<PaseoApi["agents"]["ref"]>;
type TimelinePage = Awaited<ReturnType<AgentHandle["timeline"]["refetch"]>>;
export type TimelineItem = TimelinePage["entries"][number]["item"];
type TimelineListener = Parameters<AgentHandle["timeline"]["subscribe"]>[0];
export type TimelineEvent = Parameters<TimelineListener>[0];

/** Rows a guest sees when it joins. Older history stays private to the host. */
const HISTORY_LIMIT = 200;

export type FeedEvent =
  | { type: "item"; item: GuestItem }
  | { type: "status"; status: GuestAgentStatus }
  | { type: "approval"; requestId: string; pending: boolean }
  /** History the guest holds is no longer valid; send a fresh snapshot. */
  | { type: "reset" }
  | { type: "ended"; reason: string };

/** What a guest session needs from one agent. Tests substitute their own. */
export interface AgentFeed {
  describe(): Promise<GuestAgent>;
  history(): Promise<GuestItem[]>;
  /** Resolves once live delivery is established. The returned function releases it. */
  subscribe(listener: (event: FeedEvent) => void): Promise<() => void>;
  /** Sends a guest's prompt, attributed to `sender`. */
  send(text: string, sender: string): Promise<void>;
}

export function createPaseoAgentFeed(
  paseo: PaseoApi,
  agentId: string,
  options: { includeCode: boolean },
): AgentFeed {
  const agent = paseo.agents.ref(agentId);
  const context: ProjectionContext = { cwd: null, home: homedir(), ...options };

  async function describe(): Promise<GuestAgent> {
    const result = await agent.refresh();
    if (!result) throw new Error(`Agent ${agentId} was not found`);
    context.cwd = result.agent.cwd;
    return {
      title: result.agent.title ?? "Untitled agent",
      provider: result.agent.provider,
      status: result.agent.status,
      pendingApprovals: (result.agent.pendingPermissions ?? []).map(({ id }) => id),
    };
  }

  return {
    describe,
    async history() {
      if (!context.cwd) await describe();
      const page = await agent.timeline.refetch({
        direction: "tail",
        limit: HISTORY_LIMIT,
        projection: "projected",
      });
      if (page.error) throw new Error(page.error);
      return page.entries.flatMap(({ item }) => toGuestItem(item, context) ?? []);
    },
    async subscribe(listener) {
      const unsubscribe = agent.timeline.subscribe((update) => {
        const event = toFeedEvent(update.event, context);
        if (event) listener(event);
      });
      await unsubscribe.ready;
      return () => {
        void unsubscribe.release();
      };
    },
    async send(text, sender) {
      // Steer: join a running turn instead of interrupting the host's work. An idle agent starts
      // a turn as usual; a provider that cannot steer falls back to replacing the turn.
      await agent.send(formatGuestPrompt(sender, text), { activeTurnBehavior: "steer" });
    },
  };
}
