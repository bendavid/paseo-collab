// Registers one link as its own endpoint on a Paseo relay, the way the daemon registers itself
// (packages/server/src/server/relay-transport.ts in Paseo). A control socket learns about guest
// connections; each guest gets its own data socket, which carries that guest's encrypted channel.
// The relay protocol is internal to Paseo: keep this in step with the daemon's implementation.
import type { Transport } from "@getpaseo/relay/e2ee";
import { buildRelayWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
import { WebSocket } from "ws";
import { socketTransport } from "./socket-transport";

const CONTROL_PING_INTERVAL_MS = 10_000;
const CONTROL_STALE_TIMEOUT_MS = 30_000;
const CONTROL_READY_TIMEOUT_MS = 8_000;
const DATA_OPEN_TIMEOUT_MS = 15_000;
const REGISTRATION_TIMEOUT_MS = 20_000;
const SOCKET_OPTIONS = {
  handshakeTimeout: 10_000,
  perMessageDeflate: false,
  autoSelectFamilyAttemptTimeout: 5_000,
} as const;

export interface RelayAddress {
  /** host:port */
  endpoint: string;
  useTls: boolean;
}

type ControlMessage =
  | { type: "sync"; connectionIds: string[] }
  | { type: "connected"; connectionId: string }
  | { type: "disconnected"; connectionId: string }
  | { type: "ping" }
  | { type: "pong" };

function parseControlMessage(raw: unknown): ControlMessage | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw));
    if (typeof parsed !== "object" || parsed === null) return null;
    const message = parsed as Record<string, unknown>;
    if (message.type === "ping" || message.type === "pong") return { type: message.type };
    if (message.type === "sync" && Array.isArray(message.connectionIds)) {
      return {
        type: "sync",
        connectionIds: message.connectionIds.filter(
          (id): id is string => typeof id === "string" && id.trim().length > 0,
        ),
      };
    }
    if (
      (message.type === "connected" || message.type === "disconnected") &&
      typeof message.connectionId === "string" &&
      message.connectionId.trim()
    ) {
      return { type: message.type, connectionId: message.connectionId.trim() };
    }
    return null;
  } catch {
    return null;
  }
}

export class RelayUnavailableError extends Error {
  constructor(public readonly endpoint: string) {
    super(`Could not register with the relay at ${endpoint}`);
    this.name = "RelayUnavailableError";
  }
}

export interface RelayEndpoint {
  stop(): void;
}

/**
 * Registers `serverId` on the relay and hands each guest connection to `onConnection`. Resolves
 * once the relay has accepted the registration, so a link is usable as soon as it is shown.
 */
export function openRelayEndpoint(options: {
  relay: RelayAddress;
  serverId: string;
  onConnection(transport: Transport): void;
  /** How long to keep trying before giving up on the first registration. */
  registrationTimeoutMs?: number;
}): Promise<RelayEndpoint> {
  let stopped = false;
  let control: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  const dataSockets = new Map<string, WebSocket>();

  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const firstReadyTimer = setTimeout(() => {
    rejectReady(new RelayUnavailableError(options.relay.endpoint));
    stop();
  }, options.registrationTimeoutMs ?? REGISTRATION_TIMEOUT_MS);

  function url(connectionId?: string): string {
    return buildRelayWebSocketUrl({
      ...options.relay,
      serverId: options.serverId,
      role: "server",
      ...(connectionId ? { connectionId } : {}),
    });
  }

  function stop(): void {
    stopped = true;
    clearTimeout(firstReadyTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    control?.close();
    control = null;
    for (const socket of dataSockets.values()) socket.close(1001, "Link stopped");
    dataSockets.clear();
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return;
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(
      () => {
        reconnectTimer = null;
        connectControl();
      },
      Math.min(30_000, 1_000 * reconnectAttempt),
    );
  }

  function ensureDataSocket(connectionId: string): void {
    if (stopped || dataSockets.has(connectionId)) return;
    const socket = new WebSocket(url(connectionId), SOCKET_OPTIONS);
    dataSockets.set(connectionId, socket);
    const openTimer = setTimeout(() => {
      if (socket.readyState !== WebSocket.OPEN) socket.terminate();
    }, DATA_OPEN_TIMEOUT_MS);
    // Wrap before the socket opens so no frame from the guest is missed.
    const transport = socketTransport(socket);
    socket.once("open", () => {
      clearTimeout(openTimer);
      options.onConnection(transport);
    });
    socket.on("close", () => {
      clearTimeout(openTimer);
      if (dataSockets.get(connectionId) === socket) dataSockets.delete(connectionId);
    });
    socket.on("error", () => {
      // close follows
    });
  }

  function connectControl(): void {
    if (stopped) return;
    const socket = new WebSocket(url(), SOCKET_OPTIONS);
    control = socket;
    let isReady = false;
    let lastSeenAt = Date.now();
    let keepalive: ReturnType<typeof setInterval> | null = null;
    let readyTimer: ReturnType<typeof setTimeout> | null = null;

    function cleanup(): void {
      if (keepalive) clearInterval(keepalive);
      if (readyTimer) clearTimeout(readyTimer);
    }

    socket.on("open", () => {
      lastSeenAt = Date.now();
      // The relay answers registration with a control message; a socket that stays silent is
      // half-open and gets replaced.
      readyTimer = setTimeout(() => {
        if (!isReady) socket.terminate();
      }, CONTROL_READY_TIMEOUT_MS);
      keepalive = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (Date.now() - lastSeenAt > CONTROL_STALE_TIMEOUT_MS) {
          socket.terminate();
          return;
        }
        socket.ping();
      }, CONTROL_PING_INTERVAL_MS);
      socket.ping();
    });
    socket.on("pong", () => {
      lastSeenAt = Date.now();
    });
    socket.on("message", (data) => {
      if (control !== socket) return;
      lastSeenAt = Date.now();
      const message = parseControlMessage(data);
      if (!message) return;
      if (!isReady) {
        isReady = true;
        reconnectAttempt = 0;
        if (readyTimer) clearTimeout(readyTimer);
        clearTimeout(firstReadyTimer);
        resolveReady();
      }
      switch (message.type) {
        case "ping":
          socket.send(JSON.stringify({ type: "pong", ts: Date.now() }));
          return;
        case "pong":
          return;
        case "sync":
          for (const connectionId of message.connectionIds) ensureDataSocket(connectionId);
          return;
        case "connected":
          ensureDataSocket(message.connectionId);
          return;
        case "disconnected":
          dataSockets.get(message.connectionId)?.close(1001, "Client disconnected");
          dataSockets.delete(message.connectionId);
          return;
      }
    });
    socket.on("close", () => {
      cleanup();
      if (control !== socket) return;
      control = null;
      scheduleReconnect();
    });
    socket.on("error", () => {
      // close follows and schedules the reconnect
    });
  }

  connectControl();
  return ready.then(() => ({ stop }));
}
