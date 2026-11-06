import path from "node:path";
import type { GuestDiff, GuestItem, GuestTool, GuestToolDetail } from "../shared/guest-protocol";
import type { FeedEvent, TimelineEvent, TimelineItem } from "./agent-feed";
import { parseGuestPrompt } from "./guest-envelope";
import { isSensitivePath, redactSecrets, redactTokens } from "./redact";

type ToolCallItem = Extract<TimelineItem, { type: "tool_call" }>;
type ToolDetail = ToolCallItem["detail"];

const SUMMARY_LIMIT = 300;
const COMMAND_LIMIT = 2_000;
const TEXT_LIMIT = 4_000;
const PLAN_LIMIT = 8_000;
const ERROR_LIMIT = 300;
const DIFF_LINE_LIMIT = 400;
const DIFF_LINE_LENGTH = 500;
const LIST_LIMIT = 50;

export interface ProjectionContext {
  /** The agent's working directory; paths inside it are shown relative to it. */
  cwd: string | null;
  home: string;
  /** Whether this link shares code changes. */
  includeCode: boolean;
}

function clip(text: string, limit: number): string {
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

function diffLines(lines: string[]): GuestDiff {
  const shown = lines
    .slice(0, DIFF_LINE_LIMIT)
    .map((line) => redactSecrets(clip(line, DIFF_LINE_LENGTH)));
  return { lines: shown, truncated: lines.length > DIFF_LINE_LIMIT };
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
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

function projectChange(
  filePath: string,
  context: ProjectionContext,
  lines: () => string[] | null,
): GuestDiff {
  if (!context.includeCode) return { withheld: "not-shared" };
  if (isSensitivePath(filePath)) return { withheld: "sensitive-file" };
  return diffLines(lines() ?? []);
}

function projectDetail(detail: ToolDetail, context: ProjectionContext): GuestToolDetail {
  switch (detail.type) {
    case "shell":
      return {
        kind: "shell",
        command: redactSecrets(clip(detail.command, COMMAND_LIMIT)),
        ...(detail.cwd ? { cwd: displayPath(detail.cwd, context) } : {}),
        ...(detail.exitCode !== undefined ? { exitCode: detail.exitCode } : {}),
      };
    case "read":
      return {
        kind: "read",
        path: displayPath(detail.filePath, context),
        ...(detail.offset !== undefined ? { offset: detail.offset } : {}),
        ...(detail.limit !== undefined ? { limit: detail.limit } : {}),
      };
    case "edit":
      return {
        kind: "edit",
        path: displayPath(detail.filePath, context),
        diff: projectChange(detail.filePath, context, () => {
          if (detail.unifiedDiff) return unifiedDiffLines(detail.unifiedDiff);
          if (detail.oldString === undefined && detail.newString === undefined) return null;
          return [
            ...splitLines(detail.oldString ?? "").map((line) => `-${line}`),
            ...splitLines(detail.newString ?? "").map((line) => `+${line}`),
          ];
        }),
      };
    case "write":
      return {
        kind: "write",
        path: displayPath(detail.filePath, context),
        diff: projectChange(detail.filePath, context, () =>
          detail.content === undefined ? null : splitLines(detail.content).map((l) => `+${l}`),
        ),
      };
    case "search":
      return {
        kind: "search",
        query: redactSecrets(clip(detail.query, COMMAND_LIMIT)),
        ...(detail.toolName ? { tool: detail.toolName } : {}),
        ...(detail.filePaths
          ? { files: detail.filePaths.slice(0, LIST_LIMIT).map((f) => displayPath(f, context)) }
          : {}),
        ...(detail.numFiles !== undefined ? { numFiles: detail.numFiles } : {}),
        ...(detail.numMatches !== undefined ? { numMatches: detail.numMatches } : {}),
        ...(detail.webResults
          ? {
              web: detail.webResults
                .slice(0, LIST_LIMIT)
                .map(({ title, url }) => ({ title, url: redactTokens(url) })),
            }
          : {}),
      };
    case "fetch":
      return {
        kind: "fetch",
        url: redactSecrets(detail.url),
        ...(detail.code !== undefined ? { status: detail.code } : {}),
        ...(detail.codeText ? { statusText: detail.codeText } : {}),
        ...(detail.bytes !== undefined ? { bytes: detail.bytes } : {}),
      };
    case "sub_agent":
      return {
        kind: "task",
        ...(detail.subAgentType ? { agentType: detail.subAgentType } : {}),
        ...(detail.description ? { description: redactTokens(detail.description) } : {}),
      };
    case "plain_text":
      return {
        kind: "text",
        ...(detail.label ? { label: redactTokens(clip(detail.label, SUMMARY_LIMIT)) } : {}),
        ...(detail.text ? { text: redactSecrets(clip(detail.text, TEXT_LIMIT)) } : {}),
      };
    case "plan":
      return { kind: "plan", text: redactTokens(clip(detail.text, PLAN_LIMIT)) };
    case "worktree_setup":
      return {
        kind: "worktree",
        branch: detail.branchName,
        commands: detail.commands.slice(0, LIST_LIMIT).map((command) => ({
          command: redactSecrets(clip(command.command, COMMAND_LIMIT)),
          status: command.status,
          exitCode: command.exitCode,
        })),
      };
    default:
      // Unknown and provider-specific tools (including MCP) can carry anything: name only.
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
  const message =
    typeof error === "string"
      ? error
      : typeof error === "object" &&
          error !== null &&
          typeof Reflect.get(error, "message") === "string"
        ? (Reflect.get(error, "message") as string)
        : undefined;
  return message === undefined ? undefined : redactSecrets(oneLine(clip(message, ERROR_LIMIT)));
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
        text: redactTokens(guest?.text ?? item.text),
        ...(item.messageId ? { messageId: item.messageId } : {}),
        ...(guest ? { sender: guest.sender } : {}),
      };
    }
    case "assistant_message":
      return { type: "assistant_message", text: redactTokens(item.text) };
    case "reasoning":
      return { type: "reasoning", text: redactTokens(item.text) };
    case "tool_call":
      return projectTool(item, context);
    case "todo":
      return {
        type: "todo",
        items: item.items.map(({ text, completed }) => ({ text: redactTokens(text), completed })),
      };
    case "error":
      return { type: "notice", level: "error", message: redactTokens(item.message) };
    case "notification":
      return { type: "notice", level: item.level, message: redactTokens(item.message) };
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
