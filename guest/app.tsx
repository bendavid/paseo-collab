import {
  type AppendMessage,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { useMemo } from "react";
import { GUEST_BUILD } from "./build-info";
import type { GuestSessionState } from "./session";
import { toThreadMessages } from "./convert";
import { MarkdownText, Notice, Reasoning, TodoList, ToolCard, UserText } from "./parts";

const userParts = { Text: UserText };

const assistantParts = {
  Text: MarkdownText,
  Reasoning,
  tools: { Fallback: ToolCard },
  data: { by_name: { todo: TodoList, notice: Notice } },
};

function UserMessage() {
  const from = useAuiState(({ message }) => message.metadata.custom["from"]);
  return (
    <MessagePrimitive.Root className="message message-user">
      <div className="message-label">{typeof from === "string" ? from : "Prompt"}</div>
      <div className="user-bubble">
        <MessagePrimitive.Parts components={userParts} />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="message message-assistant">
      <MessagePrimitive.Parts components={assistantParts} />
    </MessagePrimitive.Root>
  );
}

const messageComponents = { UserMessage, AssistantMessage };

function promptText(message: AppendMessage): string {
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
}

function connectionLabel(state: GuestSessionState): { text: string; kind: string } {
  switch (state.connection.status) {
    case "secure":
      return { text: "End-to-end encrypted", kind: "secure" };
    case "connecting":
      return { text: "Connecting", kind: "pending" };
    case "reconnecting":
      return { text: "Reconnecting", kind: "pending" };
    case "ended":
      return { text: "Disconnected", kind: "failed" };
  }
}

export function App({
  state,
  sendPrompt,
}: {
  state: GuestSessionState;
  sendPrompt(text: string): Promise<void>;
}) {
  const running = state.status === "running";
  const messages = useMemo(
    () => toThreadMessages(state.items, running, state.guestName),
    [state.items, running, state.guestName],
  );
  const connected = state.connection.status === "secure";
  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: running,
    isDisabled: !connected || !state.allowPrompts,
    convertMessage: (message) => message,
    onNew: async (message) => {
      const text = promptText(message);
      if (text) await sendPrompt(text);
    },
  });
  const connection = connectionLabel(state);
  const banner = state.connection.status === "ended" ? state.connection.reason : state.notice;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <header className="header">
        <div>
          <div className="title">{state.agent?.title ?? "Connecting…"}</div>
          {state.agent ? (
            <div className="meta">
              {state.agent.provider} · {running ? "working" : state.status}
              {state.includeCode ? "" : " · code changes hidden"}
            </div>
          ) : null}
        </div>
        <div className="status">
          <div className="connection" data-state={connection.kind}>
            {connection.text}
          </div>
          <div className="build" title="The commit this page was built from">
            page {GUEST_BUILD}
          </div>
        </div>
      </header>
      <ThreadPrimitive.Root className="thread">
        <ThreadPrimitive.Viewport className="viewport">
          <ThreadPrimitive.Messages components={messageComponents} />
          {state.pendingApprovals.length > 0 ? (
            <div className="working">Waiting for the host to approve a tool call…</div>
          ) : running ? (
            <div className="working">Agent is working…</div>
          ) : null}
        </ThreadPrimitive.Viewport>
        {banner ? <div className="banner">{banner}</div> : null}
        {state.allowPrompts && state.connection.status !== "ended" ? (
          <ComposerPrimitive.Root className="composer">
            <ComposerPrimitive.Input
              className="composer-input"
              placeholder="Send a prompt to the agent"
              maxLength={20_000}
              rows={2}
            />
            <ComposerPrimitive.Send className="composer-send">Send</ComposerPrimitive.Send>
          </ComposerPrimitive.Root>
        ) : null}
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
