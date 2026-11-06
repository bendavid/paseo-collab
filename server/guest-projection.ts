import path from "node:path";
import type { GuestItem, GuestLines, GuestTool, GuestToolDetail } from "../shared/guest-protocol";
import type { FeedEvent, TimelineEvent, TimelineItem } from "./agent-feed";
import { parseGuestPrompt } from "./guest-envelope";

type ToolCallItem = Extract<TimelineItem, { type: "tool_call" }>;
type ToolDetail = ToolCallItem["detail"];

/** Length of a tool card's one-line summary. */
const SUMMARY_LIMIT = 300;
/**
 * Characters per field. Not a privacy filter: one timeline row travels as one relay message,
 * which the relay caps at 32 MiB, so a giant file or output is cut here and marked truncated.
 */
const FIELD_LIMIT = 1024 * 1024;

export interface ProjectionContext {
  /** The agent's working directory; paths inside it are shown relative to it. */
  cwd: string | null;
  home: string;
}

function clip(text: string, limit = FIELD_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function oneLine(text: string): string {
  return clip(text.replace(/\s+/g, " ").trim(), SUMMARY_LIMIT);
}

/** Relative to the agent's directory when inside it, otherwise with the home directory as ~. */
export function displayPath(filePath: string, context: ProjectionContext): string {
  if (context.cwd && path.isAbsolute(filePath)) {
    const relative = path.relative(context.cwd, filePath);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
  }
  if (filePath === context.home || filePath.startsWith(`${context.home}${path.sep}`)) {
    return `~${filePath.slice(context.home.length)}`;
  }
  return filePath;
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Lines within the field limit. Command output keeps its end, where results and errors are. */
function shownLines(lines: string[], keep: "head" | "tail" = "head"): GuestLines {
  const ordered = keep === "head" ? lines : [...lines].reverse();
  const kept: string[] = [];
  let size = 0;
  for (const line of ordered) {
    const shown = clip(line);
    if (kept.length > 0 && size + shown.length > FIELD_LIMIT) break;
    kept.push(shown);
    size += shown.length + 1;
  }
  return {
    lines: keep === "head" ? kept : kept.reverse(),
    truncated: kept.length < lines.length,
  };
}

function textLines(text: string, keep: "head" | "tail" = "head"): GuestLines {
  return shownLines(splitLines(text), keep);
}

/** Tool inputs and outputs as text: strings as they are, anything else as indented JSON. */
function valueLines(value: unknown): GuestLines | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return textLines(value);
  try {
    return textLines(JSON.stringify(value, null, 2) ?? String(value));
  } catch {
    return textLines(String(value));
  }
}

/** Hunk and change lines from a unified diff, without the file headers that repeat the path. */
function unifiedDiffLines(diff: string): string[] {
  return splitLines(diff).filter(
    (line) =>
      !line.startsWith("diff --git") &&
      !line.startsWith("index ") &&
      !line.startsWith("--- ") &&
      !line.startsWith("+++ "),
  );
}

function projectDetail(detail: ToolDetail, context: ProjectionContext): GuestToolDetail {
  switch (detail.type) {
    case "shell":
      return {
        kind: "shell",
        command: clip(detail.command),
        ...(detail.cwd ? { cwd: displayPath(detail.cwd, context) } : {}),
        ...(detail.exitCode !== undefined ? { exitCode: detail.exitCode } : {}),
        ...(detail.output ? { output: textLines(detail.output, "tail") } : {}),
      };
    case "read":
      return {
        kind: "read",
        path: displayPath(detail.filePath, context),
        ...(detail.offset !== undefined ? { offset: detail.offset } : {}),
        ...(detail.limit !== undefined ? { limit: detail.limit } : {}),
        ...(detail.content !== undefined ? { content: textLines(detail.content) } : {}),
      };
    case "edit": {
      const lines = detail.unifiedDiff
        ? unifiedDiffLines(detail.unifiedDiff)
        : [
            ...splitLines(detail.oldString ?? "").map((line) => `-${line}`),
            ...splitLines(detail.newString ?? "").map((line) => `+${line}`),
          ];
      return { kind: "edit", path: displayPath(detail.filePath, context), diff: shownLines(lines) };
    }
    case "write":
      return {
        kind: "write",
        path: displayPath(detail.filePath, context),
        diff: shownLines(splitLines(detail.content ?? "").map((line) => `+${line}`)),
      };
    case "search":
      return {
        kind: "search",
        query: clip(detail.query),
        ...(detail.toolName ? { tool: detail.toolName } : {}),
        ...(detail.filePaths
          ? { files: detail.filePaths.map((file) => displayPath(file, context)) }
          : {}),
        ...(detail.numFiles !== undefined ? { numFiles: detail.numFiles } : {}),
        ...(detail.numMatches !== undefined ? { numMatches: detail.numMatches } : {}),
        ...(detail.webResults
          ? { web: detail.webResults.map(({ title, url }) => ({ title, url })) }
          : {}),
        ...(detail.content ? { content: textLines(detail.content) } : {}),
      };
    case "fetch":
      return {
        kind: "fetch",
        url: detail.url,
        ...(detail.prompt ? { prompt: clip(detail.prompt) } : {}),
        ...(detail.code !== undefined ? { status: detail.code } : {}),
        ...(detail.codeText ? { statusText: detail.codeText } : {}),
        ...(detail.bytes !== undefined ? { bytes: detail.bytes } : {}),
        ...(detail.result ? { result: textLines(detail.result) } : {}),
      };
    case "sub_agent":
      return {
        kind: "task",
        ...(detail.subAgentType ? { agentType: detail.subAgentType } : {}),
        ...(detail.description ? { description: clip(detail.description) } : {}),
      };
    case "plain_text":
      return {
        kind: "text",
        ...(detail.label ? { label: clip(detail.label, SUMMARY_LIMIT) } : {}),
        ...(detail.text ? { text: clip(detail.text) } : {}),
      };
    case "plan":
      return { kind: "plan", text: clip(detail.text) };
    case "worktree_setup":
      return {
        kind: "worktree",
        branch: detail.branchName,
        commands: detail.commands.map((command) => ({
          command: clip(command.command),
          status: command.status,
          exitCode: command.exitCode,
        })),
      };
    case "unknown": {
      // Provider-specific and MCP tools: their raw input and output.
      const input = valueLines(detail.input);
      const output = valueLines(detail.output);
      return { kind: "other", ...(input ? { input } : {}), ...(output ? { output } : {}) };
    }
    default:
      return { kind: "other" };
  }
}

function summarize(detail: GuestToolDetail): string {
  switch (detail.kind) {
    case "shell":
      return oneLine(detail.command);
    case "read":
    case "edit":
    case "write":
      return detail.path;
    case "search":
      return oneLine(detail.query);
    case "fetch":
      return detail.url;
    case "task":
      return oneLine(detail.description ?? detail.agentType ?? "");
    case "text":
      return oneLine(detail.label ?? detail.text ?? "");
    case "plan":
      return oneLine(detail.text);
    case "worktree":
      return detail.branch;
    case "other":
      return "";
  }
}

function errorMessage(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  if (typeof error === "string") return clip(error);
  const message = typeof error === "object" ? Reflect.get(error, "message") : undefined;
  if (typeof message === "string") return clip(message);
  try {
    return clip(JSON.stringify(error));
  } catch {
    return clip(String(error));
  }
}

export function projectTool(item: ToolCallItem, context: ProjectionContext): GuestTool {
  const detail = projectDetail(item.detail, context);
  const error = item.status === "failed" ? errorMessage(item.error) : undefined;
  return {
    type: "tool",
    callId: item.callId,
    name: item.name,
    status: item.status,
    summary: summarize(detail),
    detail,
    ...(error ? { error } : {}),
  };
}

/** Projects a daemon timeline item onto the guest view, or drops it. */
export function toGuestItem(item: TimelineItem, context: ProjectionContext): GuestItem | null {
  switch (item.type) {
    case "user_message": {
      const guest = parseGuestPrompt(item.text);
      return {
        type: "user_message",
        text: clip(guest?.text ?? item.text),
        ...(item.messageId ? { messageId: item.messageId } : {}),
        ...(guest ? { sender: guest.sender } : {}),
      };
    }
    case "assistant_message":
      return { type: "assistant_message", text: item.text };
    case "reasoning":
      return { type: "reasoning", text: item.text };
    case "tool_call":
      return projectTool(item, context);
    case "todo":
      return {
        type: "todo",
        items: item.items.map(({ text, completed }) => ({ text, completed })),
      };
    case "error":
      return { type: "notice", level: "error", message: item.message };
    case "notification":
      return { type: "notice", level: item.level, message: item.message };
    default:
      return null;
  }
}

/** Projects one live timeline event, or returns null for events guests do not see. */
export function toFeedEvent(
  event: TimelineEvent["event"],
  context: ProjectionContext,
): FeedEvent | null {
  switch (event.type) {
    case "timeline": {
      const item = toGuestItem(event.item, context);
      return item ? { type: "item", item } : null;
    }
    case "turn_started":
      return { type: "status", status: "running" };
    case "turn_completed":
    case "turn_canceled":
      return { type: "status", status: "idle" };
    case "turn_failed":
      return { type: "status", status: "error" };
    // Guests learn that the agent is blocked on the host, not what it asked for.
    case "permission_requested":
      return { type: "approval", requestId: event.request.id, pending: true };
    case "permission_resolved":
      return { type: "approval", requestId: event.requestId, pending: false };
    // Delivery resumed after a gap or the timeline was rewritten: history may be stale.
    case "replacement":
    case "subscription_restored":
      return { type: "reset" };
    case "error":
      return { type: "ended", reason: event.error };
    default:
      return null;
  }
}
