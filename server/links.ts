import { randomBytes, randomUUID } from "node:crypto";
import { exportPublicKey, generateKeyPair, type KeyPair } from "@getpaseo/relay/e2ee";
import { GUEST_PROTOCOL_VERSION } from "../shared/guest-version";
import { uniqueGuestName } from "../shared/guest-name";
import type { Link } from "../shared/links";
import type { AgentFeed } from "./agent-feed";
import { CLOSE_LINK_STOPPED, type GuestSession, startGuestSession } from "./guest-session";
import { openRelayEndpoint, type RelayAddress, type RelayEndpoint } from "./relay-endpoint";

/** Simultaneous guests per link. */
const MAX_GUESTS = 8;
/** Failed handshakes or wrong secrets before the link shuts itself down. */
const MAX_REJECTIONS = 20;

export interface LinkManagerOptions {
  relay: RelayAddress;
  /** The static guest page, e.g. https://you.github.io/paseo-collab-link/ */
  guestPageUrl: string;
  /** How long link creation waits for the relay to accept the registration. */
  registrationTimeoutMs?: number;
}

/** One connection to the link, from before its handshake until it closes. */
interface Guest {
  /** Unique among the link's connections. */
  name: string;
  /** Presented the secret; only admitted guests are listed as connected. */
  admitted: boolean;
  session: GuestSession | null;
}

interface ActiveLink {
  link: Omit<Link, "guests" | "participants">;
  endpoint: RelayEndpoint;
  guests: Set<Guest>;
  /** Numbers guest connections; a reconnecting guest gets a new number. */
  connections: number;
  rejections: number;
  stopping: Promise<void> | null;
}

/** base64url keeps the key intact inside a URL fragment, where `+` would read as a space. */
export function encodeKey(publicKey: Uint8Array): string {
  return Buffer.from(exportPublicKey(publicKey), "base64").toString("base64url");
}

/** A relay id shaped like the daemon's own, fresh for every link. */
function newServerId(): string {
  return `srv_${randomBytes(9).toString("base64url")}`;
}

/**
 * Everything after `#` stays in the guest's browser: the page learns where to connect, which
 * key the host must prove it holds, and the secret that admits the guest.
 */
export function invitationUrl(options: {
  guestPageUrl: string;
  relay: RelayAddress;
  serverId: string;
  keyPair: KeyPair;
  secret: string;
}): string {
  const fragment = new URLSearchParams({
    v: String(GUEST_PROTOCOL_VERSION),
    relay: options.relay.endpoint,
    tls: options.relay.useTls ? "1" : "0",
    id: options.serverId,
    k: encodeKey(options.keyPair.publicKey),
    s: options.secret,
  });
  return `${options.guestPageUrl}#${fragment.toString()}`;
}

/** Names of the link's admitted guests, in the order they joined. */
function connectedNames(active: ActiveLink): string[] {
  return [...active.guests].filter((guest) => guest.admitted).map((guest) => guest.name);
}

/** Tells every admitted guest who is connected, after a join, rename, or leave. */
function announceParticipants(active: ActiveLink): void {
  const names = connectedNames(active);
  for (const guest of active.guests) {
    if (guest.admitted) guest.session?.announceParticipants(names);
  }
}

export class LinkManager {
  private readonly links = new Map<string, ActiveLink>();
  /** One create at a time per agent, so a double tap cannot register two endpoints. */
  private readonly creating = new Map<string, Promise<Link>>();

  constructor(private readonly options: LinkManagerOptions) {}

  list(agentId?: string): Link[] {
    return [...this.links.values()]
      .filter((active) => !active.stopping && (!agentId || active.link.agentId === agentId))
      .map((active) => {
        const participants = connectedNames(active);
        return { ...active.link, guests: participants.length, participants };
      });
  }

  /** Returns the agent's live link, or starts one. */
  create(options: { agentId: string; allowPrompts: boolean; feed: AgentFeed }): Promise<Link> {
    const existing = this.list(options.agentId)[0];
    if (existing) return Promise.resolve(existing);
    const inFlight = this.creating.get(options.agentId);
    if (inFlight) return inFlight;
    const created = this.start(options).finally(() => this.creating.delete(options.agentId));
    this.creating.set(options.agentId, created);
    return created;
  }

  async stop(linkId: string): Promise<boolean> {
    const active = this.links.get(linkId);
    if (!active) return false;
    await this.teardown(linkId, active);
    return true;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.links].map(([linkId, active]) => this.teardown(linkId, active)));
  }

  private async start(options: {
    agentId: string;
    allowPrompts: boolean;
    feed: AgentFeed;
  }): Promise<Link> {
    const linkId = randomUUID();
    const serverId = newServerId();
    const keyPair = generateKeyPair();
    const secret = randomBytes(32).toString("base64url");
    let active: ActiveLink | null = null;

    const endpoint = await openRelayEndpoint({
      relay: this.options.relay,
      serverId,
      ...(this.options.registrationTimeoutMs
        ? { registrationTimeoutMs: this.options.registrationTimeoutMs }
        : {}),
      onConnection: (transport) => {
        if (!active || active.stopping) return transport.close(CLOSE_LINK_STOPPED, "link stopped");
        if (active.guests.size >= MAX_GUESTS) return transport.close(4429, "too many guests");
        const owner = active;
        const guest: Guest = {
          name: `Guest ${++owner.connections}`,
          admitted: false,
          session: null,
        };
        owner.guests.add(guest);
        guest.session = startGuestSession({
          transport,
          keyPair,
          secret,
          allowPrompts: options.allowPrompts,
          guestName: guest.name,
          claimName: (requested) => {
            const others = [...owner.guests].filter((other) => other !== guest);
            guest.name = uniqueGuestName(
              requested,
              others.map((other) => other.name),
            );
            announceParticipants(owner);
            return guest.name;
          },
          feed: options.feed,
          onAuthenticated: () => {
            guest.admitted = true;
            announceParticipants(owner);
          },
          onRejected: () => {
            owner.rejections += 1;
            if (owner.rejections >= MAX_REJECTIONS) void this.teardown(linkId, owner);
          },
          onClosed: (admitted) => {
            owner.guests.delete(guest);
            if (admitted) announceParticipants(owner);
          },
        });
      },
    });

    active = {
      link: {
        linkId,
        agentId: options.agentId,
        url: invitationUrl({
          guestPageUrl: this.options.guestPageUrl,
          relay: this.options.relay,
          serverId,
          keyPair,
          secret,
        }),
        allowPrompts: options.allowPrompts,
        createdAt: new Date().toISOString(),
      },
      endpoint,
      guests: new Set(),
      connections: 0,
      rejections: 0,
      stopping: null,
    };
    this.links.set(linkId, active);
    return { ...active.link, guests: 0, participants: [] };
  }

  private teardown(linkId: string, active: ActiveLink): Promise<void> {
    active.stopping ??= (async () => {
      // Sessions tell their guests before closing; the relay replaces close codes.
      await Promise.allSettled(
        [...active.guests].map((guest) => guest.session?.close(CLOSE_LINK_STOPPED, "link stopped")),
      );
      active.endpoint.stop();
      this.links.delete(linkId);
    })();
    return active.stopping;
  }
}
