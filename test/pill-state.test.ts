import { describe, expect, it } from "vitest";
import { IDLE_PILL, pillLabel, pillStates, pillTitle, samePillState } from "../client/pill-state";
import type { Link } from "../shared/links";

const link = (agentId: string, participants: string[]): Link => ({
  linkId: `l-${agentId}`,
  agentId,
  url: "https://g/#x",
  allowPrompts: true,
  guests: participants.length,
  participants,
  createdAt: "2026-11-06T00:00:00.000Z",
});

describe("Collab pill", () => {
  it("is idle without a link, and counts connected guests while one is live", () => {
    const states = pillStates([link("a1", []), link("a2", ["Alice", "Bob"])]);

    expect(states.get("a3") ?? IDLE_PILL).toEqual({ active: false, guests: 0 });
    expect(pillLabel(IDLE_PILL)).toBe("Collab");
    expect(pillLabel(states.get("a1")!)).toBe("Collab");
    expect(pillTitle(states.get("a1")!)).toBe("Link active, no guests connected");
    expect(pillLabel(states.get("a2")!)).toBe("Collab · 2");
    expect(pillTitle(states.get("a2")!)).toBe("Link active, 2 guests connected");
  });

  it("only changes when the link starts, stops, or the guest count moves", () => {
    expect(samePillState({ active: true, guests: 2 }, { active: true, guests: 2 })).toBe(true);
    expect(samePillState({ active: true, guests: 2 }, { active: true, guests: 3 })).toBe(false);
    expect(samePillState(IDLE_PILL, { active: true, guests: 0 })).toBe(false);
  });
});
