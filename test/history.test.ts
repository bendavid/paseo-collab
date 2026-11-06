import { describe, expect, it } from "vitest";
import { readWholeTimeline, TimelineChangedError, type TimelineItem } from "../server/agent-feed";
import type { GuestItem } from "../shared/guest-protocol";
import { foldItems } from "../shared/timeline-fold";

type Refetch = Parameters<typeof readWholeTimeline>[0]["timeline"]["refetch"];

/** A timeline of `rows`, served in pages the way the daemon does, newest first. */
function pagedTimeline(rows: TimelineItem[], epochs: () => string) {
  const calls: { direction?: string; seq?: number }[] = [];
  const refetch = (async (options?: Parameters<Refetch>[0]) => {
    const epoch = epochs();
    const end =
      options?.direction === "before" ? (options.cursor?.seq ?? rows.length) : rows.length;
    const limit = options?.limit ?? rows.length;
    const start = Math.max(0, end - limit);
    calls.push({ direction: options?.direction, seq: options?.cursor?.seq });
    return {
      epoch,
      error: null,
      hasOlder: start > 0,
      startCursor: { epoch, seq: start },
      entries: rows.slice(start, end).map((item) => ({ item })),
    };
  }) as unknown as Refetch;
  return { agent: { timeline: { refetch } } as Parameters<typeof readWholeTimeline>[0], calls };
}

const rows = (count: number): TimelineItem[] =>
  Array.from(
    { length: count },
    (_, i) => ({ type: "assistant_message", text: `${i}` }) as TimelineItem,
  );

describe("full history for late joiners", () => {
  it("reads every page, oldest first", async () => {
    const all = rows(1_200);
    const { agent, calls } = pagedTimeline(all, () => "e1");

    expect(await readWholeTimeline(agent)).toEqual(all);
    expect(calls).toEqual([
      { direction: "tail", seq: undefined },
      { direction: "before", seq: 700 },
      { direction: "before", seq: 200 },
    ]);
  });

  it("starts over when the timeline is rewritten mid-read, and gives up if it keeps changing", async () => {
    const all = rows(800);
    let reads = 0;
    const settles = pagedTimeline(all, () => (++reads === 2 ? "e2" : reads < 2 ? "e1" : "e3"));
    expect(await readWholeTimeline(settles.agent)).toEqual(all);

    let flips = 0;
    const churns = pagedTimeline(all, () => `e${++flips}`);
    await expect(readWholeTimeline(churns.agent)).rejects.toBeInstanceOf(TimelineChangedError);
  });

  it("joins a reply or tool call that a page boundary split", () => {
    const tool = (status: "running" | "completed"): GuestItem => ({
      type: "tool",
      callId: "c1",
      name: "Bash",
      status,
      summary: "npm test",
      detail: { kind: "shell", command: "npm test" },
    });
    expect(
      foldItems([
        { type: "user_message", text: "go" },
        { type: "assistant_message", text: "Work" },
        { type: "assistant_message", text: "ing" },
        tool("running"),
        { type: "reasoning", text: "a" },
        tool("completed"),
      ]),
    ).toEqual([
      { type: "user_message", text: "go" },
      { type: "assistant_message", text: "Working" },
      tool("completed"),
      { type: "reasoning", text: "a" },
    ]);
  });
});
