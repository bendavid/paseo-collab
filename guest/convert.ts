import type { ThreadMessageLike } from "@assistant-ui/react";
import type { GuestItem } from "../shared/guest-protocol";

type Part = Exclude<ThreadMessageLike["content"], string>[number];

function toPart(item: Exclude<GuestItem, { type: "user_message" }>): Part {
  switch (item.type) {
    case "assistant_message":
      return { type: "text", text: item.text };
    case "reasoning":
      return { type: "reasoning", text: item.text };
    case "tool":
      return {
        type: "tool-call",
        toolCallId: item.callId,
        toolName: item.name,
        // The whole guest tool row travels as args; the tool card renders it.
        args: JSON.parse(JSON.stringify(item)),
        ...(item.status === "running" ? {} : { result: { status: item.status } }),
        ...(item.status === "failed" ? { isError: true } : {}),
      };
    case "todo":
      return { type: "data-todo", data: item.items };
    case "notice":
      return { type: "data-notice", data: { level: item.level, message: item.message } };
  }
}

/** Who sent a prompt, from this guest's point of view. */
export function senderLabel(sender: string | undefined, self: string | null): string {
  if (!sender) return "Host";
  return sender === self ? "You" : sender;
}

/**
 * Groups the guest timeline into assistant-ui messages: each prompt is a user message, and
 * everything the agent produced until the next prompt is one assistant message. Ids derive from
 * positions, so a message keeps its identity while it grows.
 */
export function toThreadMessages(
  items: readonly GuestItem[],
  running: boolean,
  self: string | null = null,
): ThreadMessageLike[] {
  const messages: ThreadMessageLike[] = [];
  let parts: Part[] = [];
  let startIndex = 0;

  function flushAssistant(): void {
    if (parts.length === 0) return;
    messages.push({ id: `a${startIndex}`, role: "assistant", content: parts });
    parts = [];
  }

  items.forEach((item, index) => {
    if (item.type === "user_message") {
      flushAssistant();
      messages.push({
        id: `u${index}`,
        role: "user",
        content: [{ type: "text", text: item.text }],
        metadata: { custom: { from: senderLabel(item.sender, self) } },
      });
      return;
    }
    if (parts.length === 0) startIndex = index;
    parts.push(toPart(item));
  });
  flushAssistant();

  const last = messages[messages.length - 1];
  if (last?.role === "assistant") {
    messages[messages.length - 1] = {
      ...last,
      status: running ? { type: "running" } : { type: "complete", reason: "unknown" },
    };
  }
  return messages;
}
