// Messages between the guest page and the plugin server. Both directions travel inside the
// Noise channel, so the relay only ever carries ciphertext. The guest page imports these types
// only; the server validates what guests send with the schemas.
import { z } from "zod";

/** Upper bound on one guest prompt, in characters. */
export const MAX_PROMPT_LENGTH = 20_000;

export const GuestInboundSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), secret: z.string().min(1).max(256) }),
  z.object({ type: z.literal("prompt"), text: z.string().trim().min(1).max(MAX_PROMPT_LENGTH) }),
]);

export type GuestInbound = z.input<typeof GuestInboundSchema>;

export type GuestToolStatus = "running" | "completed" | "failed" | "canceled";

/** A change shown to guests, or why it was withheld. */
export type GuestDiff =
  { lines: string[]; truncated: boolean } | { withheld: "sensitive-file" | "not-shared" };

/**
 * What a guest may know about a tool call. Inputs and metadata only: command output, file
 * contents, fetched pages, and search matches never leave the daemon. Paths are relative to the
 * agent's directory, and free text is scrubbed of recognizable secrets.
 */
export type GuestToolDetail =
  | { kind: "shell"; command: string; cwd?: string; exitCode?: number | null }
  | { kind: "read"; path: string; offset?: number; limit?: number }
  | { kind: "edit"; path: string; diff: GuestDiff }
  | { kind: "write"; path: string; diff: GuestDiff }
  | {
      kind: "search";
      query: string;
      tool?: string;
      files?: string[];
      numFiles?: number;
      numMatches?: number;
      web?: { title: string; url: string }[];
    }
  | { kind: "fetch"; url: string; status?: number; statusText?: string; bytes?: number }
  | { kind: "task"; agentType?: string; description?: string }
  | { kind: "text"; label?: string; text?: string }
  | { kind: "plan"; text: string }
  | {
      kind: "worktree";
      branch: string;
      commands: { command: string; status: string; exitCode: number | null }[];
    }
  | { kind: "other" };

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
      includeCode: boolean;
      /** How this guest's prompts are labelled for the agent and other guests. */
      guestName: string;
    }
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
