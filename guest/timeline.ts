import { GUEST_PROTOCOL_VERSION } from "../shared/guest-version";

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
