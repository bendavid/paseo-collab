import { describe, expect, it } from "vitest";
import type { TimelineItem } from "../server/agent-feed";
import { type ProjectionContext, toFeedEvent, toGuestItem } from "../server/guest-projection";

type ToolCall = Extract<TimelineItem, { type: "tool_call" }>;

const context: ProjectionContext = { cwd: "/home/ada/shop", home: "/home/ada" };

function tool(detail: ToolCall["detail"], extra: Partial<ToolCall> = {}): ToolCall {
  return {
    type: "tool_call",
    callId: "c1",
    name: "tool",
    status: "completed",
    error: null,
    detail,
    ...extra,
  } as ToolCall;
}

describe("tool details shared with guests", () => {
  it("shares a command, its exit code, and its output verbatim", () => {
    const item = toGuestItem(
      tool({
        type: "shell",
        command: 'curl -H "Authorization: Bearer abcdefghijklmnop" https://api.example.com',
        cwd: "/home/ada/shop/web",
        output: "line one\nAPI_KEY=hunter2\n",
        exitCode: 0,
      }),
      context,
    );

    expect(item).toMatchObject({
      detail: {
        kind: "shell",
        command: 'curl -H "Authorization: Bearer abcdefghijklmnop" https://api.example.com',
        cwd: "web",
        exitCode: 0,
        output: { lines: ["line one", "API_KEY=hunter2"], truncated: false },
      },
    });
  });

  it("shares file contents and diffs, secret files included", () => {
    expect(
      toGuestItem(
        tool({ type: "read", filePath: "/home/ada/shop/.env", content: "TOKEN=abc\nDEBUG=1\n" }),
        context,
      ),
    ).toMatchObject({
      summary: ".env",
      detail: { kind: "read", path: ".env", content: { lines: ["TOKEN=abc", "DEBUG=1"] } },
    });
    expect(
      toGuestItem(
        tool({
          type: "edit",
          filePath: "/home/ada/shop/src/config.ts",
          unifiedDiff:
            '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-const key = "old";\n+const key = "sk-ant-new";\n',
        }),
        context,
      ),
    ).toMatchObject({
      detail: {
        kind: "edit",
        path: "src/config.ts",
        diff: {
          lines: ["@@ -1 +1 @@", '-const key = "old";', '+const key = "sk-ant-new";'],
          truncated: false,
        },
      },
    });
    expect(
      toGuestItem(tool({ type: "read", filePath: "/home/ada/notes/todo.md" }), context),
    ).toMatchObject({ detail: { path: "~/notes/todo.md" } });
  });

  it("shares search matches, fetched pages, and MCP inputs and outputs", () => {
    expect(
      toGuestItem(
        tool({ type: "search", query: "TODO", content: "src/a.ts:3:// TODO fix\n" }),
        context,
      ),
    ).toMatchObject({ detail: { content: { lines: ["src/a.ts:3:// TODO fix"] } } });
    expect(
      toGuestItem(
        tool({
          type: "fetch",
          url: "https://example.com/docs",
          prompt: "What is the limit?",
          result: "The limit is 5.",
          code: 200,
        }),
        context,
      ),
    ).toMatchObject({
      detail: {
        kind: "fetch",
        prompt: "What is the limit?",
        status: 200,
        result: { lines: ["The limit is 5."] },
      },
    });
    expect(
      toGuestItem(
        tool(
          { type: "unknown", input: { sql: "select 1" }, output: "1 row" },
          { name: "mcp__db__query" },
        ),
        context,
      ),
    ).toMatchObject({
      name: "mcp__db__query",
      detail: {
        kind: "other",
        input: { lines: ["{", '  "sql": "select 1"', "}"] },
        output: { lines: ["1 row"] },
      },
    });
  });

  it("keeps the end of very long output, where the result is, within one relay message", () => {
    const output = Array.from({ length: 40_000 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join(
      "\n",
    );
    const item = toGuestItem(tool({ type: "shell", command: "build", output }), context);
    const shown = (item as { detail: { output: { lines: string[]; truncated: boolean } } }).detail
      .output;

    expect(shown.truncated).toBe(true);
    expect(shown.lines.at(-1)).toBe(`line 39999 ${"x".repeat(40)}`);
    expect(shown.lines.join("\n").length).toBeLessThanOrEqual(1024 * 1024);
  });

  it("passes conversation text and failures through unchanged", () => {
    expect(
      toGuestItem(
        { type: "assistant_message", text: "Use ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
        context,
      ),
    ).toEqual({ type: "assistant_message", text: "Use ghp_abcdefghijklmnopqrstuvwxyz0123456789" });
    expect(
      toGuestItem(
        tool(
          { type: "shell", command: "git push" },
          { status: "failed", error: { message: "denied" } },
        ),
        context,
      ),
    ).toMatchObject({ status: "failed", error: "denied" });
  });

  it("asks for a fresh snapshot after a gap or a rewritten timeline", () => {
    expect(toFeedEvent({ type: "replacement", epoch: "e2" }, context)).toEqual({ type: "reset" });
    expect(toFeedEvent({ type: "subscription_restored" }, context)).toEqual({ type: "reset" });
  });
});
