// A Node stand-in for the guest page: same relay URL, same channel, same messages.
import { buildRelayWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
import { openClientSecureChannel, type SecureChannel } from "@getpaseo/relay/e2ee";
import { WebSocket } from "ws";
import { readInvitation } from "../guest/timeline";
import { socketTransport } from "../server/socket-transport";
import type { GuestInbound, GuestOutbound } from "../shared/guest-protocol";

export interface GuestClient {
  messages: GuestOutbound[];
  closed: Promise<number>;
  send(message: GuestInbound): Promise<void>;
  next(predicate: (message: GuestOutbound) => boolean): Promise<GuestOutbound>;
  close(): void;
}

export async function connectGuest(options: {
  url: string;
  secret?: string;
}): Promise<GuestClient> {
  const result = readInvitation(new URL(options.url).hash);
  if (!result.ok) throw new Error(result.reason);
  const { invitation } = result;
  const socket = new WebSocket(
    buildRelayWebSocketUrl({
      ...invitation.relay,
      serverId: invitation.serverId,
      role: "client",
    }),
  );
  const closed = new Promise<number>((resolve) => socket.on("close", (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });

  const messages: GuestOutbound[] = [];
  const waiters: { predicate: (m: GuestOutbound) => boolean; resolve(m: GuestOutbound): void }[] =
    [];
  const opened = await new Promise<SecureChannel>((resolve, reject) => {
    const opening = openClientSecureChannel(socketTransport(socket), {
      daemonPublicKeyB64: invitation.key,
      minimumMode: "protected",
      events: {
        onopen: () => void opening.then(resolve),
        onmessage: (data) => {
          const message = JSON.parse(String(data)) as GuestOutbound;
          messages.push(message);
          for (const waiter of [...waiters]) {
            if (!waiter.predicate(message)) continue;
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(message);
          }
        },
      },
    });
    opening.catch(reject);
  });
  await opened.send(JSON.stringify({ type: "hello", secret: options.secret ?? invitation.secret }));

  return {
    messages,
    closed,
    send: (message) => opened.send(JSON.stringify(message)),
    next(predicate) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
    },
    close: () => socket.close(),
  };
}
