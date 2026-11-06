import { homedir } from "node:os";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { GuestAgent, GuestAgentStatus, GuestItem } from "../shared/guest-protocol";
import { formatGuestPrompt } from "./guest-envelope";
import { foldItems } from "../shared/timeline-fold";
import { type ProjectionContext, toFeedEvent, toGuestItem } from "./guest-projection";

type PaseoApi = PluginHandlerContext["paseo"];
type AgentHandle = ReturnType<PaseoApi["agents"]["ref"]>;
type TimelinePage = Awaited<ReturnType<AgentHandle["timeline"]["refetch"]>>;
export type TimelineItem = TimelinePage["entries"][number]["item"];
type TimelineListener = Parameters<AgentHandle["timeline"]["subscribe"]>[0];
export type TimelineEvent = Parameters<TimelineListener>[0];

/** Rows per history page; a guest receives every page. */
const HISTORY_PAGE_SIZE = 500;
/** Attempts to read history in one epoch before giving up. */
const HISTORY_ATTEMPTS = 3;

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

export class TimelineChangedError extends Error {
  constructor() {
    super("The agent's timeline kept changing while its history was read");
    this.name = "TimelineChangedError";
  }
}

/**
 * Reads every row, newest page first. A timeline rewritten mid-read (a new epoch) restarts the
 * read so pages from two versions are never mixed.
 */
export async function readWholeTimeline(
  agent: Pick<AgentHandle, "timeline">,
): Promise<TimelineItem[]> {
  for (let attempt = 0; attempt < HISTORY_ATTEMPTS; attempt += 1) {
    let page = await agent.timeline.refetch({
      direction: "tail",
      limit: HISTORY_PAGE_SIZE,
      projection: "projected",
    });
    if (page.error) throw new Error(page.error);
    const epoch = page.epoch;
    const pages = [page.entries];
    while (page.hasOlder && page.startCursor) {
      page = await agent.timeline.refetch({
        direction: "before",
        cursor: page.startCursor,
        limit: HISTORY_PAGE_SIZE,
        projection: "projected",
      });
      if (page.error) throw new Error(page.error);
      if (page.epoch !== epoch) break;
      pages.unshift(page.entries);
    }
    if (page.epoch === epoch) return pages.flat().map(({ item }) => item);
  }
  throw new TimelineChangedError();
}

export function createPaseoAgentFeed(paseo: PaseoApi, agentId: string): AgentFeed {
  const agent = paseo.agents.ref(agentId);
  const context: ProjectionContext = { cwd: null, home: homedir() };

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
      const rows = await readWholeTimeline(agent);
      return foldItems(rows.flatMap((item) => toGuestItem(item, context) ?? []));
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
