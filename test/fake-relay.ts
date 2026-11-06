// An in-process stand-in for the Paseo relay's routing: one control socket per serverId, a data
// socket per client connection, frames forwarded unchanged. Like the real relay it replaces
// close codes, and it records every frame so tests can check what the relay could see.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type RawData, WebSocket, WebSocketServer } from "ws";

interface Client {
  socket: WebSocket;
  buffered: { data: RawData; isBinary: boolean }[];
  server: WebSocket | null;
}

export interface FakeRelay {
  endpoint: string;
  /** Every frame the relay forwarded, in either direction, as it saw them. */
  frames: string[];
  close(): Promise<void>;
}

export async function startFakeRelay(): Promise<FakeRelay> {
  const controls = new Map<string, WebSocket>();
  const clients = new Map<string, Map<string, Client>>();
  const frames: string[] = [];
  const http = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const sockets = new WebSocketServer({ server: http, path: "/ws" });

  function forward(target: WebSocket, data: RawData, isBinary: boolean): void {
    frames.push(Buffer.isBuffer(data) ? data.toString("latin1") : String(data));
    if (target.readyState === WebSocket.OPEN) target.send(data, { binary: isBinary });
  }

  sockets.on("connection", (socket, request) => {
    const url = new URL(request.url ?? "/", "http://relay");
    const serverId = url.searchParams.get("serverId") ?? "";
    const role = url.searchParams.get("role");
    const connectionId = url.searchParams.get("connectionId");
    const byServer = clients.get(serverId) ?? new Map<string, Client>();
    clients.set(serverId, byServer);

    if (role === "server" && !connectionId) {
      controls.set(serverId, socket);
      socket.send(JSON.stringify({ type: "sync", connectionIds: [...byServer.keys()] }));
      socket.on("close", () => {
        if (controls.get(serverId) === socket) controls.delete(serverId);
      });
      return;
    }

    if (role === "server" && connectionId) {
      const client = byServer.get(connectionId);
      if (!client) return socket.close(1008, "Unknown connection");
      client.server = socket;
      for (const frame of client.buffered.splice(0)) forward(socket, frame.data, frame.isBinary);
      socket.on("message", (data, isBinary) => forward(client.socket, data, isBinary));
      socket.on("close", () => client.socket.close(1012, "Server disconnected"));
      return;
    }

    if (role === "client") {
      const control = controls.get(serverId);
      if (!control) return socket.close(1012, "Server unavailable");
      const id = randomUUID();
      const client: Client = { socket, buffered: [], server: null };
      byServer.set(id, client);
      socket.on("message", (data, isBinary) => {
        if (client.server) forward(client.server, data, isBinary);
        else client.buffered.push({ data, isBinary });
      });
      socket.on("close", () => {
        byServer.delete(id);
        client.server?.close(1001, "Client disconnected");
        controls.get(serverId)?.send(JSON.stringify({ type: "disconnected", connectionId: id }));
      });
      control.send(JSON.stringify({ type: "connected", connectionId: id }));
      return;
    }
    socket.close(1008, "Bad role");
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", () => resolve()));
  const { port } = http.address() as AddressInfo;
  return {
    endpoint: `127.0.0.1:${port}`,
    frames,
    async close() {
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
