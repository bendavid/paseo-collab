// Messages between the guest page and the plugin server. Both directions travel inside the
// Noise channel, so the relay only ever carries ciphertext. The guest page imports these types
// only; the server validates what guests send with the schemas.
import { z } from "zod";

/** Upper bound on one guest prompt, in characters. */
export const MAX_PROMPT_LENGTH = 20_000;

export const GuestInboundSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), secret: z.string().min(1).max(256) }),
  z.object({ type: z.literal("prompt"), text: z.string().trim().min(1).max(MAX_PROMPT_LENGTH) }),
  /** Only sent to plugins whose welcome says `canRename`; older plugins reject unknown messages. */
  z.object({ type: z.literal("set_name"), name: z.string().max(200) }),
]);

export type GuestInbound = z.input<typeof GuestInboundSchema>;

export type GuestToolStatus = "running" | "completed" | "failed" | "canceled";

/** Lines shown to guests: a diff, command output, file contents, or a tool's input or output. */
export type GuestLines =
  | { lines: string[]; truncated: boolean }
  // COMPAT(withheldLines): plugin 0.1.0 withheld diffs of secret-looking files, and all diffs
  // unless the link opted in. The page is always the latest tag, so it keeps explaining these
  // markers while hosts still run 0.1.0.
  | { withheld: "sensitive-file" | "not-shared" };

/**
 * Everything the timeline holds about a tool call. Paths are relative to the agent's directory;
 * very long fields are cut to fit relay messages and marked truncated.
 */
export type GuestToolDetail =
  | {
      kind: "shell";
      command: string;
      cwd?: string;
      exitCode?: number | null;
      /** The end of the output, where results and errors are. */
      output?: GuestLines;
    }
  | {
      kind: "read";
      path: string;
      offset?: number;
      limit?: number;
      content?: GuestLines;
    }
  | { kind: "edit"; path: string; diff: GuestLines }
  | { kind: "write"; path: string; diff: GuestLines }
  | {
      kind: "search";
      query: string;
      tool?: string;
      files?: string[];
      numFiles?: number;
      numMatches?: number;
      web?: { title: string; url: string }[];
      /** Matching lines; lines from secret-looking files are withheld individually. */
      content?: GuestLines;
    }
  | {
      kind: "fetch";
      url: string;
      /** What the agent asked about the page. */
      prompt?: string;
      status?: number;
      statusText?: string;
      bytes?: number;
      result?: GuestLines;
    }
  | { kind: "task"; agentType?: string; description?: string }
  | { kind: "text"; label?: string; text?: string }
  | { kind: "plan"; text: string }
  | {
      kind: "worktree";
      branch: string;
      commands: { command: string; status: string; exitCode: number | null }[];
    }
  /** Provider-specific and MCP tools. */
  | { kind: "other"; input?: GuestLines; output?: GuestLines };

export interface GuestTool {
  type: "tool";
  callId: string;
  name: string;
  status: GuestToolStatus;
  summary: string;
  detail: GuestToolDetail;
  /** A short, scrubbed failure message. */
  error?: string;
}

/** The guest's view of a timeline row. */
export type GuestItem =
  /** `sender` names the guest who sent it; the host's own prompts have none. */
  | { type: "user_message"; text: string; messageId?: string; sender?: string }
  | { type: "assistant_message"; text: string }
  | { type: "reasoning"; text: string }
  | GuestTool
  | { type: "todo"; items: { text: string; completed: boolean }[] }
  | { type: "notice"; level: "info" | "warning" | "error"; message: string };

export type GuestAgentStatus = "idle" | "running" | "error" | "closed" | "initializing";

export interface GuestAgent {
  title: string;
  provider: string;
  status: GuestAgentStatus;
  /** Tool calls waiting for the host to approve them. */
  pendingApprovals: string[];
}

export type GuestOutbound =
  | {
      type: "welcome";
      agent: GuestAgent;
      allowPrompts: boolean;
      /** How this guest's prompts are labelled for the agent and other guests. */
      guestName: string;
      /** The plugin accepts `set_name`. Absent from plugins before 0.3.0. */
      canRename?: boolean;
    }
  /** The name the host accepted, possibly numbered to keep names unique on the link. */
  | { type: "renamed"; guestName: string }
  /** Replaces the guest's timeline. Large snapshots continue in `snapshot_more` messages. */
  | { type: "snapshot"; items: GuestItem[] }
  | { type: "snapshot_more"; items: GuestItem[] }
  | { type: "item"; item: GuestItem }
  | { type: "status"; status: GuestAgentStatus }
  | { type: "approval"; requestId: string; pending: boolean }
  | { type: "prompt_rejected"; reason: string }
  /**
   * Sent just before the host closes the connection. The relay replaces WebSocket close codes,
   * so the reason travels in band.
   */
  | { type: "closing"; code: number; reason: string };
