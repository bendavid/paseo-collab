import { exportPublicKey, generateKeyPair } from "@getpaseo/relay/e2ee";
import { describe, expect, it } from "vitest";
import { senderLabel, toThreadMessages } from "../guest/convert";
import { readInvitation } from "../guest/timeline";
import { applyItem, foldItems } from "../shared/timeline-fold";
import { invitationUrl } from "../server/links";
import type { GuestTool } from "../shared/guest-protocol";

const bash = (status: GuestTool["status"]): GuestTool => ({
  type: "tool",
  callId: "c1",
  name: "Bash",
  status,
  summary: "npm test",
  detail: { kind: "shell", command: "npm test" },
});

describe("guest timeline", () => {
  it("joins streamed assistant text and replaces a tool call's earlier state", () => {
    let items = applyItem([], { type: "user_message", text: "Fix it" });
    items = applyItem(items, { type: "assistant_message", text: "Look" });
    items = applyItem(items, { type: "assistant_message", text: "ing" });
    items = applyItem(items, bash("running"));
    items = applyItem(items, { type: "assistant_message", text: "Done" });
    items = applyItem(items, bash("completed"));

    expect(items).toEqual([
      { type: "user_message", text: "Fix it" },
      { type: "assistant_message", text: "Looking" },
      bash("completed"),
      { type: "assistant_message", text: "Done" },
    ]);
  });

  it("recovers the relay, endpoint id, key, and secret from the link fragment", () => {
    const keyPair = generateKeyPair();
    const url = invitationUrl({
      guestPageUrl: "https://you.github.io/paseo-collab-link/",
      relay: { endpoint: "relay.paseo.sh:443", useTls: true },
      serverId: "srv_abc",
      keyPair,
      secret: "s3cr3t_-",
    });

    expect(url.startsWith("https://you.github.io/paseo-collab-link/#")).toBe(true);
    expect(readInvitation(new URL(url).hash)).toEqual({
      ok: true,
      invitation: {
        relay: { endpoint: "relay.paseo.sh:443", useTls: true },
        serverId: "srv_abc",
        key: exportPublicKey(keyPair.publicKey),
        secret: "s3cr3t_-",
      },
    });
  });

  it("refuses incomplete links, other protocol versions, and plain-text remote relays", () => {
    const base = "v=1&relay=relay.paseo.sh%3A443&tls=1&id=srv_a&k=AAAA&s=b";
    expect(readInvitation(`#${base}`).ok).toBe(true);
    expect(readInvitation("#v=1&relay=relay.paseo.sh%3A443&id=srv_a").ok).toBe(false);
    expect(readInvitation(`#${base.replace("v=1", "v=2")}`)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/different version/),
    });
    expect(readInvitation(`#${base.replace("tls=1", "tls=0")}`).ok).toBe(false);
    expect(
      readInvitation(`#${base.replace("relay.paseo.sh", "127.0.0.1").replace("tls=1", "tls=0")}`)
        .ok,
    ).toBe(true);
    expect(
      readInvitation(`#${base.replace("relay.paseo.sh%3A443", "evil.example%2Fpath%3A1")}`).ok,
    ).toBe(false);
  });

  it("groups each prompt's work into one assistant message that is running while the agent works", () => {
    const messages = toThreadMessages(
      [
        { type: "user_message", text: "Fix it" },
        { type: "reasoning", text: "Check tests" },
        bash("completed"),
        { type: "assistant_message", text: "Fixed." },
        { type: "user_message", text: "Thanks" },
        { type: "todo", items: [{ text: "Ship", completed: false }] },
      ],
      true,
    );

    expect(messages.map((m) => [m.id, m.role, m.status?.type])).toEqual([
      ["u0", "user", undefined],
      ["a1", "assistant", undefined],
      ["u4", "user", undefined],
      ["a5", "assistant", "running"],
    ]);
    expect(messages[1]?.content).toEqual([
      { type: "reasoning", text: "Check tests" },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "Bash",
        args: bash("completed"),
        result: { status: "completed" },
      },
      { type: "text", text: "Fixed." },
    ]);
    expect(messages[0]?.metadata?.custom).toEqual({ from: "Host" });
    expect(messages[3]?.content).toEqual([
      { type: "data-todo", data: [{ text: "Ship", completed: false }] },
    ]);
  });

  it("labels prompts from this guest as You and the host's as Host", () => {
    expect(senderLabel(undefined, "Guest 2")).toBe("Host");
    expect(senderLabel("Guest 2", "Guest 2")).toBe("You");
    expect(senderLabel("Guest 1", "Guest 2")).toBe("Guest 1");
  });
});
