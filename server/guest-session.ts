import { timingSafeEqual } from "node:crypto";
import { type KeyPair, openDaemonSecureChannel, type Transport } from "@getpaseo/relay/e2ee";
import {
  type GuestInbound,
  GuestInboundSchema,
  type GuestItem,
  type GuestOutbound,
} from "../shared/guest-protocol";
import type { AgentFeed, FeedEvent } from "./agent-feed";

/** A guest must complete the handshake and present the secret within this window. */
const HELLO_TIMEOUT_MS = 15_000;
/** Bound on one snapshot message; the relay caps WebSocket messages at 32 MiB. */
const SNAPSHOT_BATCH_BYTES = 1024 * 1024;
/** How long a closing notice may take before the connection closes anyway. */
const CLOSING_NOTICE_MS = 2_000;
/** Close codes the guest page understands. Browsers only accept 1000 and 3000-4999 from peers. */
export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_LINK_STOPPED = 4410;
export const CLOSE_PROTOCOL = 4400;
export const CLOSE_FEED_ENDED = 4500;

export interface GuestSessionOptions {
  transport: Transport;
  keyPair: KeyPair;
  secret: string;
  allowPrompts: boolean;
  includeCode: boolean;
  /** Assigned by the link; guests cannot choose it. */
  guestName: string;
  feed: AgentFeed;
  onAuthenticated(): void;
  onRejected(reason: "handshake" | "secret"): void;
  onClosed(authenticated: boolean): void;
}

export interface GuestSession {
  /** Tells the guest why, then closes. Resolves once the connection is closed. */
  close(code: number, reason: string): Promise<void>;
}

/** Splits a snapshot so no single message grows past the batch size. */
export function snapshotBatches(items: GuestItem[]): GuestItem[][] {
  const batches: GuestItem[][] = [[]];
  let size = 0;
  for (const item of items) {
    const itemSize = JSON.stringify(item).length;
    const current = batches[batches.length - 1]!;
    if (current.length > 0 && size + itemSize > SNAPSHOT_BATCH_BYTES) {
      batches.push([item]);
      size = itemSize;
    } else {
      current.push(item);
      size += itemSize;
    }
  }
  return batches;
}

function secretsMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseInbound(data: string | ArrayBuffer): GuestInbound | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = GuestInboundSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Runs one guest connection from handshake to close. */
export function startGuestSession(options: GuestSessionOptions): GuestSession {
  let authenticated = false;
  let closed = false;
  /** The transport already went away, so there is no one left to notify. */
  let transportGone = false;
  let releaseFeed: (() => void) | null = null;
  // Live events that arrive while the snapshot is being read are replayed after it.
  let pending: FeedEvent[] | null = null;

  const helloTimer = setTimeout(
    () => void close(CLOSE_UNAUTHORIZED, "hello timeout"),
    HELLO_TIMEOUT_MS,
  );

  function close(code: number, reason: string): Promise<void> {
    if (closed) return Promise.resolve();
    closed = true;
    clearTimeout(helloTimer);
    releaseFeed?.();
    releaseFeed = null;
    options.onClosed(authenticated);
    if (transportGone) {
      options.transport.close(code, reason);
      return Promise.resolve();
    }
    const notice: GuestOutbound = { type: "closing", code, reason };
    return opened.then(
      (ready) =>
        Promise.race([
          ready.send(JSON.stringify(notice)).catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, CLOSING_NOTICE_MS)),
        ]).then(() => ready.close(code, reason)),
      () => options.transport.close(code, reason),
    );
  }

  function send(message: GuestOutbound): void {
    if (closed) return;
    // The channel replays records buffered during the handshake before its promise settles, so
    // a guest's first message can arrive first. Chaining on the promise also keeps send order.
    void opened
      .then((ready) => ready.send(JSON.stringify(message)))
      .catch(() => close(CLOSE_PROTOCOL, "send failed"));
  }

  function deliver(event: FeedEvent): void {
    switch (event.type) {
      case "item":
        send({ type: "item", item: event.item });
        return;
      case "status":
        send({ type: "status", status: event.status });
        return;
      case "approval":
        send({ type: "approval", requestId: event.requestId, pending: event.pending });
        return;
      case "reset":
        void sendSnapshot();
        return;
      case "ended":
        close(CLOSE_FEED_ENDED, event.reason);
        return;
    }
  }

  async function sendSnapshot(): Promise<void> {
    pending = [];
    try {
      const [agent, items] = await Promise.all([options.feed.describe(), options.feed.history()]);
      send({
        type: "welcome",
        agent,
        allowPrompts: options.allowPrompts,
        includeCode: options.includeCode,
        guestName: options.guestName,
      });
      const [first = [], ...rest] = snapshotBatches(items);
      send({ type: "snapshot", items: first });
      for (const batch of rest) send({ type: "snapshot_more", items: batch });
    } catch (error) {
      close(CLOSE_FEED_ENDED, error instanceof Error ? error.message : "agent unavailable");
      return;
    }
    const queued = pending;
    pending = null;
    for (const event of queued) deliver(event);
  }

  async function admit(): Promise<void> {
    authenticated = true;
    clearTimeout(helloTimer);
    options.onAuthenticated();
    pending = [];
    try {
      const release = await options.feed.subscribe((event) => {
        if (pending) pending.push(event);
        else deliver(event);
      });
      if (closed) return release();
      releaseFeed = release;
    } catch (error) {
      close(CLOSE_FEED_ENDED, error instanceof Error ? error.message : "agent unavailable");
      return;
    }
    await sendSnapshot();
  }

  async function handleMessage(data: string | ArrayBuffer): Promise<void> {
    const message = parseInbound(data);
    if (!message) return close(CLOSE_PROTOCOL, "invalid message");
    if (!authenticated) {
      if (message.type !== "hello" || !secretsMatch(message.secret, options.secret)) {
        options.onRejected("secret");
        return close(CLOSE_UNAUTHORIZED, "invalid invitation");
      }
      return admit();
    }
    if (message.type !== "prompt") return close(CLOSE_PROTOCOL, "unexpected message");
    if (!options.allowPrompts) {
      return send({ type: "prompt_rejected", reason: "This link is view-only." });
    }
    try {
      await options.feed.send(message.text, options.guestName);
    } catch (error) {
      send({
        type: "prompt_rejected",
        reason: error instanceof Error ? error.message : "The agent did not accept the prompt.",
      });
    }
  }

  const opened = openDaemonSecureChannel(options.transport, {
    daemonKeyPair: options.keyPair,
    minimumMode: "protected",
    events: {
      onmessage: (data) => void handleMessage(data),
      onclose: () => {
        transportGone = true;
        void close(CLOSE_PROTOCOL, "closed");
      },
      onerror: () => {
        transportGone = true;
        void close(CLOSE_PROTOCOL, "channel error");
      },
    },
  });
  opened.catch(() => {
    options.onRejected("handshake");
    void close(CLOSE_PROTOCOL, "handshake failed");
  });

  return { close };
}
