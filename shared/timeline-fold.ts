import type { GuestItem } from "./guest-protocol";

/**
 * Folds one live item into the guest's timeline the way the daemon's projection does: streamed
 * assistant and reasoning text joins the previous chunk, and a tool call's later states replace
 * its earlier one.
 */
export function applyItem(items: GuestItem[], item: GuestItem): GuestItem[] {
  const last = items[items.length - 1];
  if (
    (item.type === "assistant_message" || item.type === "reasoning") &&
    last?.type === item.type
  ) {
    return [...items.slice(0, -1), { ...last, text: last.text + item.text }];
  }
  if (item.type === "tool") {
    const index = items.findIndex((row) => row.type === "tool" && row.callId === item.callId);
    if (index !== -1) return items.map((row, i) => (i === index ? item : row));
  }
  if (item.type === "user_message" && item.messageId) {
    const index = items.findIndex(
      (row) => row.type === "user_message" && row.messageId === item.messageId,
    );
    if (index !== -1) return items.map((row, i) => (i === index ? item : row));
  }
  return [...items, item];
}

/**
 * Folds a whole list at once, for history read in pages: a page boundary can split a streamed
 * reply or separate a tool call's states. Linear in the number of items.
 */
export function foldItems(items: readonly GuestItem[]): GuestItem[] {
  const folded: GuestItem[] = [];
  const toolIndex = new Map<string, number>();
  const messageIndex = new Map<string, number>();
  for (const item of items) {
    const last = folded[folded.length - 1];
    if (
      (item.type === "assistant_message" || item.type === "reasoning") &&
      last?.type === item.type
    ) {
      folded[folded.length - 1] = { ...last, text: last.text + item.text };
      continue;
    }
    const key =
      item.type === "tool"
        ? toolIndex
        : item.type === "user_message" && item.messageId
          ? messageIndex
          : null;
    const id =
      item.type === "tool"
        ? item.callId
        : item.type === "user_message"
          ? item.messageId
          : undefined;
    const existing = key && id !== undefined ? key.get(id) : undefined;
    if (existing !== undefined) {
      folded[existing] = item;
      continue;
    }
    if (key && id !== undefined) key.set(id, folded.length);
    folded.push(item);
  }
  return folded;
}
