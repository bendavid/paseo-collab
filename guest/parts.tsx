import type {
  DataMessagePartProps,
  ReasoningMessagePartProps,
  TextMessagePartProps,
  ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive, type SyntaxHighlighterProps } from "@assistant-ui/react-markdown";
import {
  type HighlightToken,
  highlightCode,
  highlightLine,
  isLanguageSupported,
} from "@getpaseo/highlight";
import { type ReactNode, useMemo } from "react";
import remarkGfm from "remark-gfm";
import type { GuestDiff, GuestTool, GuestToolDetail } from "../shared/guest-protocol";

/** Longest code block the page highlights; longer blocks render plain. */
const HIGHLIGHT_LIMIT = 40_000;

const LANGUAGE_EXTENSIONS: Record<string, string> = {
  typescript: "ts",
  javascript: "js",
  python: "py",
  shell: "sh",
  bash: "sh",
  zsh: "sh",
  console: "sh",
  rust: "rs",
  golang: "go",
  yaml: "yml",
  markdown: "md",
  "c++": "cpp",
  csharp: "cs",
  kotlin: "kt",
  ruby: "rb",
};

function fileNameForLanguage(language: string): string {
  const lower = language.toLowerCase();
  return `snippet.${LANGUAGE_EXTENSIONS[lower] ?? lower}`;
}

function Tokens({ tokens }: { tokens: HighlightToken[] }) {
  return (
    <>
      {tokens.map((token, index) =>
        token.style ? (
          <span key={index} className={`hl-${token.style}`}>
            {token.text}
          </span>
        ) : (
          token.text
        ),
      )}
    </>
  );
}

function HighlightedCode({ code, fileName }: { code: string; fileName: string }) {
  const lines = useMemo(() => {
    if (code.length > HIGHLIGHT_LIMIT || !isLanguageSupported(fileName)) return null;
    return highlightCode(code, fileName);
  }, [code, fileName]);
  if (!lines) return <>{code}</>;
  return (
    <>
      {lines.map((tokens, index) => (
        <span key={index}>
          <Tokens tokens={tokens} />
          {index < lines.length - 1 ? "\n" : null}
        </span>
      ))}
    </>
  );
}

function SyntaxHighlighter({ components: { Pre, Code }, language, code }: SyntaxHighlighterProps) {
  return (
    <Pre className="code-block">
      <Code>
        <HighlightedCode code={code} fileName={fileNameForLanguage(language || "txt")} />
      </Code>
    </Pre>
  );
}

const markdownComponents = { SyntaxHighlighter };
const remarkPlugins = [remarkGfm];

/** Assistant text. react-markdown escapes raw HTML and drops unsafe link schemes. */
export function MarkdownText() {
  return (
    <MarkdownTextPrimitive
      className="markdown"
      components={markdownComponents}
      remarkPlugins={remarkPlugins}
    />
  );
}

/** Prompts are shown as typed, without Markdown. */
export function UserText({ text }: TextMessagePartProps) {
  return <>{text}</>;
}

export function Reasoning({ text, status }: ReasoningMessagePartProps) {
  return (
    <details className="reasoning">
      <summary>{status?.type === "running" ? "Thinking…" : "Thinking"}</summary>
      <div className="reasoning-text">{text}</div>
    </details>
  );
}

const STATUS_LABEL: Record<GuestTool["status"], string> = {
  running: "Running",
  completed: "Done",
  failed: "Failed",
  canceled: "Canceled",
};

function DiffView({ diff, path }: { diff: GuestDiff; path: string }) {
  if ("withheld" in diff) {
    return (
      <div className="tool-note">
        {diff.withheld === "sensitive-file"
          ? "Changes to this file are never shared."
          : "The host did not share code changes."}
      </div>
    );
  }
  const highlight = isLanguageSupported(path);
  return (
    <pre className="diff">
      {diff.lines.map((line, index) => {
        const marker = line[0];
        const kind = line.startsWith("@@")
          ? "hunk"
          : marker === "+"
            ? "add"
            : marker === "-"
              ? "del"
              : "ctx";
        const body = kind === "hunk" ? line : line.slice(1);
        return (
          <div key={index} className={`diff-line diff-${kind}`}>
            <span className="diff-marker">
              {kind === "hunk" ? "" : marker === " " ? " " : marker}
            </span>
            {highlight && kind !== "hunk" ? <Tokens tokens={highlightLine(body, path)} /> : body}
          </div>
        );
      })}
      {diff.truncated ? <div className="diff-line diff-hunk">… more lines not shown</div> : null}
    </pre>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="tool-row">
      <span className="tool-row-label">{label}</span>
      <span className="tool-row-value">{children}</span>
    </div>
  );
}

function DetailView({ detail }: { detail: GuestToolDetail }) {
  switch (detail.kind) {
    case "shell":
      return (
        <>
          <pre className="command">
            <HighlightedCode code={detail.command} fileName="command.sh" />
          </pre>
          {detail.cwd ? <Row label="Directory">{detail.cwd}</Row> : null}
          {detail.exitCode !== undefined && detail.exitCode !== null ? (
            <Row label="Exit code">{detail.exitCode}</Row>
          ) : null}
          <div className="tool-note">Command output is not shared.</div>
        </>
      );
    case "read":
      return (
        <>
          <Row label="File">{detail.path}</Row>
          {detail.offset !== undefined || detail.limit !== undefined ? (
            <Row label="Lines">
              {detail.offset ?? 1}
              {detail.limit !== undefined ? ` – ${(detail.offset ?? 1) + detail.limit - 1}` : "+"}
            </Row>
          ) : null}
        </>
      );
    case "edit":
    case "write":
      return (
        <>
          <Row label="File">{detail.path}</Row>
          <DiffView diff={detail.diff} path={detail.path} />
        </>
      );
    case "search":
      return (
        <>
          <Row label="Query">{detail.query}</Row>
          {detail.numMatches !== undefined ? <Row label="Matches">{detail.numMatches}</Row> : null}
          {detail.numFiles !== undefined ? <Row label="Files">{detail.numFiles}</Row> : null}
          {detail.files?.length ? (
            <ul className="tool-list">
              {detail.files.map((file) => (
                <li key={file}>{file}</li>
              ))}
            </ul>
          ) : null}
          {detail.web?.length ? (
            <ul className="tool-list">
              {detail.web.map((result) => (
                <li key={result.url}>
                  <a href={result.url} target="_blank" rel="noopener noreferrer nofollow">
                    {result.title || result.url}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      );
    case "fetch":
      return (
        <>
          <Row label="URL">{detail.url}</Row>
          {detail.status !== undefined ? (
            <Row label="Status">
              {detail.status} {detail.statusText ?? ""}
            </Row>
          ) : null}
          {detail.bytes !== undefined ? <Row label="Size">{detail.bytes} bytes</Row> : null}
        </>
      );
    case "task":
      return (
        <>
          {detail.agentType ? <Row label="Agent">{detail.agentType}</Row> : null}
          {detail.description ? <div className="tool-text">{detail.description}</div> : null}
        </>
      );
    case "text":
      return detail.text ? <div className="tool-text">{detail.text}</div> : null;
    case "plan":
      return <div className="tool-text">{detail.text}</div>;
    case "worktree":
      return (
        <>
          <Row label="Branch">{detail.branch}</Row>
          {detail.commands.map((command, index) => (
            <Row key={index} label={command.status}>
              <code>{command.command}</code>
            </Row>
          ))}
        </>
      );
    case "other":
      return <div className="tool-note">Details of this tool are not shared.</div>;
  }
}

/** One tool call. Its full guest row rides in `args`, set by convert.ts. */
export function ToolCard({ args }: ToolCallMessagePartProps) {
  const tool = args as unknown as GuestTool;
  return (
    <details className="tool" data-status={tool.status}>
      <summary>
        <span className="tool-status">{STATUS_LABEL[tool.status]}</span>
        <span className="tool-name">{tool.name}</span>
        <span className="tool-summary">{tool.summary}</span>
      </summary>
      <div className="tool-body">
        <DetailView detail={tool.detail} />
        {tool.error ? <div className="tool-error">{tool.error}</div> : null}
      </div>
    </details>
  );
}

interface TodoEntry {
  text: string;
  completed: boolean;
}

export function TodoList({ data }: DataMessagePartProps<TodoEntry[]>) {
  const entries: TodoEntry[] = data;
  return (
    <ul className="todo">
      {entries.map((entry, index) => (
        <li key={index} className={entry.completed ? "done" : undefined}>
          <span aria-hidden="true">{entry.completed ? "☑" : "☐"}</span> {entry.text}
        </li>
      ))}
    </ul>
  );
}

export function Notice({ data }: DataMessagePartProps<{ level: string; message: string }>) {
  return (
    <div className="notice" data-level={data.level}>
      {data.message}
    </div>
  );
}
