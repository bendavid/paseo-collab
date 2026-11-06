import { describe, expect, it } from "vitest";
import { normalizeGuestName, uniqueGuestName } from "../shared/guest-name";

describe("guest names", () => {
  it("strips control characters, collapses whitespace, and caps the length", () => {
    expect(normalizeGuestName("  Ada\u0007   Lovelace\n ")).toBe("Ada Lovelace");
    expect(normalizeGuestName(" \t ")).toBe("");
    expect(normalizeGuestName("x".repeat(100))).toHaveLength(40);
  });

  it("numbers a name another guest holds, and never hands out Host or You", () => {
    expect(uniqueGuestName("Alice", ["Bob"])).toBe("Alice");
    expect(uniqueGuestName("alice", ["Alice"])).toBe("alice 2");
    expect(uniqueGuestName("Alice", ["Alice", "alice 2"])).toBe("Alice 3");
    expect(uniqueGuestName("Host", [])).toBe("Host 2");
    expect(uniqueGuestName("YOU", [])).toBe("YOU 2");
    expect(uniqueGuestName("y".repeat(40), ["y".repeat(40)])).toHaveLength(40);
  });
});
