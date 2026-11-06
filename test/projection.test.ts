import { describe, expect, it } from "vitest";
import type { TimelineItem } from "../server/agent-feed";
import { type ProjectionContext, toFeedEvent, toGuestItem } from "../server/guest-projection";
import { isSensitivePath, redactSecrets, redactTokens } from "../server/redact";

type ToolCall = Extract<TimelineItem, { type: "tool_call" }>;

const context = (includeCode: boolean): ProjectionContext => ({
  cwd: "/home/ada/shop",
  home: "/home/ada",
  includeCode,
});

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
  it("shares a command and its exit code but never its output", () => {
    const item = toGuestItem(
      tool({
        type: "shell",
        command: 'curl -H "Authorization: Bearer abcdefghijklmnop" https://api.example.com',
        cwd: "/home/ada/shop/web",
        output: "SECRET_OUTPUT_LINE",
        exitCode: 0,
      }),
      context(true),
    );

    expect(item).toMatchObject({
      detail: {
        kind: "shell",
        command: 'curl -H "Authorization: Bearer [redacted]" https://api.example.com',
        cwd: "web",
        exitCode: 0,
      },
    });
    expect(JSON.stringify(item)).not.toContain("SECRET_OUTPUT_LINE");
  });

  it("shares file paths and line ranges but never file contents", () => {
    const item = toGuestItem(
      tool({
        type: "read",
        filePath: "/home/ada/shop/src/app.ts",
        content: "FILE_CONTENTS",
        offset: 10,
        limit: 20,
      }),
      context(true),
    );

    expect(item).toMatchObject({
      summary: "src/app.ts",
      detail: { kind: "read", path: "src/app.ts", offset: 10, limit: 20 },
    });
    expect(JSON.stringify(item)).not.toContain("FILE_CONTENTS");
    expect(
      toGuestItem(tool({ type: "read", filePath: "/home/ada/notes/todo.md" }), context(true)),
    ).toMatchObject({ detail: { path: "~/notes/todo.md" } });
  });

  it("shares diffs only when the link includes code, never for secret files", () => {
    const edit = (filePath: string) =>
      tool({
        type: "edit",
        filePath,
        unifiedDiff: [
          "--- a/src/config.ts",
          "+++ b/src/config.ts",
          "@@ -1,2 +1,2 @@",
          ' const region = "eu";',
          '-const apiKey = "old-value-123";',
          '+const apiKey = "sk-ant-abcdefghijklmnopqrstuv";',
        ].join("\n"),
      });

    expect(toGuestItem(edit("/home/ada/shop/src/config.ts"), context(false))).toMatchObject({
      detail: { kind: "edit", diff: { withheld: "not-shared" } },
    });
    expect(toGuestItem(edit("/home/ada/shop/.env.local"), context(true))).toMatchObject({
      detail: { kind: "edit", diff: { withheld: "sensitive-file" } },
    });
    expect(toGuestItem(edit("/home/ada/shop/src/config.ts"), context(true))).toMatchObject({
      detail: {
        kind: "edit",
        path: "src/config.ts",
        diff: {
          lines: [
            "@@ -1,2 +1,2 @@",
            ' const region = "eu";',
            "-const apiKey = [redacted];",
            "+const apiKey = [redacted];",
          ],
          truncated: false,
        },
      },
    });
  });

  it("caps long diffs", () => {
    const content = Array.from({ length: 450 }, (_, i) => `line ${i}`).join("\n");
    const item = toGuestItem(
      tool({ type: "write", filePath: "/home/ada/shop/big.txt", content }),
      context(true),
    );

    expect(item).toMatchObject({ detail: { diff: { truncated: true } } });
    expect((item as { detail: { diff: { lines: string[] } } }).detail.diff.lines).toHaveLength(400);
  });

  it("shares only the name of tools it does not know, such as MCP tools", () => {
    const item = toGuestItem(
      tool(
        { type: "unknown", input: { query: "PRIVATE_INPUT" }, output: "PRIVATE_OUTPUT" },
        { name: "mcp__db__query" },
      ),
      context(true),
    );

    expect(item).toMatchObject({ name: "mcp__db__query", detail: { kind: "other" } });
    expect(JSON.stringify(item)).not.toMatch(/PRIVATE_/);
  });

  it("scrubs tokens from conversation text and failure messages", () => {
    expect(
      toGuestItem(
        { type: "assistant_message", text: "Use ghp_abcdefghijklmnopqrstuvwxyz0123456789 here" },
        context(false),
      ),
    ).toEqual({ type: "assistant_message", text: "Use [redacted] here" });
    expect(
      toGuestItem(
        tool(
          { type: "shell", command: "deploy" },
          { status: "failed", error: { message: "denied for token=abcdefghijklmnop" } },
        ),
        context(false),
      ),
    ).toMatchObject({ status: "failed", error: "denied for token=[redacted]" });
  });

  it("asks for a fresh snapshot after a gap or a rewritten timeline", () => {
    expect(toFeedEvent({ type: "replacement", epoch: "e2" }, context(false))).toEqual({
      type: "reset",
    });
    expect(toFeedEvent({ type: "subscription_restored" }, context(false))).toEqual({
      type: "reset",
    });
  });
});

describe("redaction", () => {
  it("keeps ordinary code intact", () => {
    const code = "const token = await getToken(user);\nif (password.length < 8) return;";
    expect(redactSecrets(code)).toBe(code);
    expect(redactTokens("see https://example.com/docs")).toBe("see https://example.com/docs");
  });

  it("scrubs URL credentials and private keys", () => {
    expect(redactTokens("git clone https://ada:hunter2@git.example.com/x.git")).toBe(
      "git clone https://ada:[redacted]@git.example.com/x.git",
    );
    expect(
      redactTokens("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----"),
    ).toBe("[redacted]");
  });

  it("recognizes secret-bearing files", () => {
    for (const file of [
      ".env",
      "app/.env.production",
      "id_ed25519",
      "certs/server.key",
      "config/client_secret.json",
      "secrets.yaml",
    ]) {
      expect(isSensitivePath(file), file).toBe(true);
    }
    expect(isSensitivePath("/home/ada/.ssh/config")).toBe(true);
    expect(isSensitivePath("/home/ada/.aws/credentials")).toBe(true);
    for (const file of [
      "src/env.ts",
      "README.md",
      "src/token-bucket.ts",
      "docs/secrets-guide.md",
    ]) {
      expect(isSensitivePath(file), file).toBe(false);
    }
  });
});
