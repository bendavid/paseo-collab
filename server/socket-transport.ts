import type { Transport } from "@getpaseo/relay/e2ee";
import { type RawData, WebSocket } from "ws";

function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return copy.buffer;
}

/** Adapts a ws socket to the transport the relay's secure channel drives. */
export function socketTransport(socket: WebSocket): Transport {
  const transport: Transport = {
    send(data) {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    },
    close(code, reason) {
      socket.close(code, reason);
    },
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  socket.on("message", (data, isBinary) => {
    const buffer = toBuffer(data);
    transport.onmessage?.(
      isBinary
        ? { data: toArrayBuffer(buffer), isBinary: true }
        : { data: buffer.toString("utf8"), isBinary: false },
    );
  });
  socket.on("close", (code, reason) => transport.onclose?.(code, reason.toString("utf8")));
  socket.on("error", (error) => transport.onerror?.(error));
  return transport;
}
