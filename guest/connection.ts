import { buildRelayWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
import { openClientSecureChannel, type SecureChannel, type Transport } from "@getpaseo/relay/e2ee";
import type { GuestInbound, GuestOutbound } from "../shared/guest-protocol";
import type { Invitation } from "./timeline";

// Close codes sent by the plugin server (server/guest-session.ts) and by the channel itself.
const CLOSE_PROTOCOL = 4400;
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_LINK_STOPPED = 4410;
const CLOSE_FEED_ENDED = 4500;
const CLOSE_HANDSHAKE_FAILED = 4002;
const CLOSE_RECORD_FAILED = 4003;
/** Reconnects after a session that worked: network blips and relay restarts. */
const MAX_RETRIES = 8;
/**
 * Attempts before the first secure session. The relay replaces close codes, so a stopped link,
 * a wrong key, and a host that is offline look the same; do not make the guest wait long.
 */
const MAX_FIRST_ATTEMPTS = 2;
/**
 * The relay keeps a guest's socket open while no host is registered for the link, so a stopped
 * link never closes on its own. Give each attempt this long to complete the handshake.
 */
const HANDSHAKE_TIMEOUT_MS = 6_000;
const CLOSE_HANDSHAKE_TIMEOUT = 4000;

export type ConnectionState =
  | { status: "connecting" }
  | { status: "secure" }
  | { status: "reconnecting"; attempt: number }
  | { status: "ended"; reason: string };

const FINAL_REASONS: Record<number, string> = {
  [CLOSE_UNAUTHORIZED]: "This invitation is not valid.",
  [CLOSE_LINK_STOPPED]: "The host stopped sharing this agent.",
  [CLOSE_FEED_ENDED]: "The agent is no longer available.",
  [CLOSE_PROTOCOL]: "The host rejected this connection. The link may be incomplete.",
  [CLOSE_HANDSHAKE_FAILED]:
    "Could not verify the host. The link may be incomplete or tampered with.",
  [CLOSE_RECORD_FAILED]: "Could not verify the host. The link may be incomplete or tampered with.",
};

/**
 * `onLocalClose` runs as soon as this side closes the socket: a close event may never follow if
 * the relay does not complete the closing handshake, and the page must not sit at "Connecting".
 */
function browserTransport(socket: WebSocket, onLocalClose: (code: number) => void): Transport {
  socket.binaryType = "arraybuffer";
  const transport: Transport = {
    send: (data) => socket.send(data),
    close: (code, reason) => {
      onLocalClose(code ?? 1000);
      socket.close(code, reason);
    },
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) =>
    transport.onmessage?.({ data: event.data, isBinary: typeof event.data !== "string" });
  socket.onclose = (event) => transport.onclose?.(event.code, event.reason);
  socket.onerror = () => transport.onerror?.(new Error("WebSocket error"));
  return transport;
}

/** Keeps one encrypted session with the host, reconnecting after transient failures. */
export class GuestConnection {
  private channel: SecureChannel | null = null;
  private retries = 0;
  private ended = false;
  private everConnected = false;

  constructor(
    private readonly invitation: Invitation,
    private readonly handlers: {
      onMessage(message: GuestOutbound): void;
      onState(state: ConnectionState): void;
    },
  ) {}

  start(): void {
    this.handlers.onState({ status: "connecting" });
    this.connect();
  }

  async send(message: GuestInbound): Promise<void> {
    if (!this.channel) throw new Error("Not connected to the host.");
    await this.channel.send(JSON.stringify(message));
  }

  private end(reason: string): void {
    this.ended = true;
    this.channel = null;
    this.handlers.onState({ status: "ended", reason });
  }

  private onClosed(code: number): void {
    this.channel = null;
    if (this.ended) return;
    const final = FINAL_REASONS[code];
    if (final) return this.end(final);
    if (!this.everConnected && this.retries >= MAX_FIRST_ATTEMPTS - 1) {
      return this.end(
        "Could not connect to the host. The link may have been stopped, or it is incomplete.",
      );
    }
    if (this.retries >= MAX_RETRIES) return this.end("Lost the connection to the host.");
    this.retries += 1;
    this.handlers.onState({ status: "reconnecting", attempt: this.retries });
    setTimeout(() => this.connect(), Math.min(1000 * 2 ** (this.retries - 1), 15_000));
  }

  private connect(): void {
    const socket = new WebSocket(
      buildRelayWebSocketUrl({
        ...this.invitation.relay,
        serverId: this.invitation.serverId,
        role: "client",
      }),
    );
    let closed = false;
    const settle = (code: number) => {
      if (closed) return;
      closed = true;
      clearTimeout(handshakeTimer);
      this.onClosed(code);
    };
    const transport = browserTransport(socket, settle);
    socket.addEventListener("close", (event) => settle(event.code));
    const handshakeTimer = setTimeout(
      () => transport.close(CLOSE_HANDSHAKE_TIMEOUT, "handshake timeout"),
      HANDSHAKE_TIMEOUT_MS,
    );
    socket.addEventListener("open", () => {
      const admitted = (channel: SecureChannel) => {
        clearTimeout(handshakeTimer);
        // The host proved it holds the key from the link; now prove we hold the secret.
        void channel.send(JSON.stringify({ type: "hello", secret: this.invitation.secret }));
        this.channel = channel;
        this.retries = 0;
        this.everConnected = true;
        this.handlers.onState({ status: "secure" });
      };
      const opening = openClientSecureChannel(transport, {
        daemonPublicKeyB64: this.invitation.key,
        minimumMode: "protected",
        events: {
          // The promise settles once our hello is sent, before the host's reply opens the channel.
          onopen: () => void opening.then(admitted),
          onmessage: (data) => {
            if (typeof data !== "string") return;
            const message = JSON.parse(data) as GuestOutbound;
            // The relay replaces close codes, so the host says why it is closing in band.
            if (message.type === "closing") {
              this.end(FINAL_REASONS[message.code] ?? message.reason);
              return;
            }
            this.handlers.onMessage(message);
          },
        },
      });
      opening.catch(() => transport.close(CLOSE_HANDSHAKE_FAILED, "handshake failed"));
    });
  }
}
