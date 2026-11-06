import type { GuestItem } from "../shared/guest-protocol";
import { GUEST_PROTOCOL_VERSION } from "../shared/guest-version";

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

/** base64url (used in the link) back to the standard base64 the channel expects. */
export function base64UrlToBase64(value: string): string {
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  return standard + "=".repeat((4 - (standard.length % 4)) % 4);
}

export interface Invitation {
  /** host:port of the relay, and whether to use TLS. */
  relay: { endpoint: string; useTls: boolean };
  serverId: string;
  key: string;
  secret: string;
}

export type InvitationResult = { ok: true; invitation: Invitation } | { ok: false; reason: string };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const ENDPOINT = /^(\[[0-9a-f:]+\]|[a-z0-9.-]+):(\d{1,5})$/i;

/** Reads the link's fragment. Plain-text relays are accepted only on this machine, for development. */
export function readInvitation(hash: string): InvitationResult {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const version = params.get("v");
  const endpoint = params.get("relay");
  const serverId = params.get("id");
  const key = params.get("k");
  const secret = params.get("s");
  if (!version || !endpoint || !serverId || !key || !secret) {
    return { ok: false, reason: "This link is incomplete. Ask the host for the full link." };
  }
  if (version !== String(GUEST_PROTOCOL_VERSION)) {
    return {
      ok: false,
      reason:
        "This link comes from a different version of the collaboration plugin than this page " +
        "supports. Ask the host to update the plugin.",
    };
  }
  const host = ENDPOINT.exec(endpoint)?.[1]?.toLowerCase();
  const useTls = params.get("tls") !== "0";
  if (!host || (!useTls && !LOCAL_HOSTS.has(host))) {
    return { ok: false, reason: "This link names a relay this page will not connect to." };
  }
  return {
    ok: true,
    invitation: { relay: { endpoint, useTls }, serverId, key: base64UrlToBase64(key), secret },
  };
}
