import { useCallback, useEffect, useReducer, useRef } from "react";
import type {
  GuestAgent,
  GuestAgentStatus,
  GuestItem,
  GuestOutbound,
} from "../shared/guest-protocol";
import { type ConnectionState, GuestConnection } from "./connection";
import { applyItem } from "../shared/timeline-fold";
import type { InvitationResult } from "./timeline";

export interface GuestSessionState {
  connection: ConnectionState;
  agent: GuestAgent | null;
  status: GuestAgentStatus;
  items: GuestItem[];
  allowPrompts: boolean;
  pendingApprovals: string[];
  /** This guest's own name, so its prompts can read as "You". */
  guestName: string | null;
  /** Whether the page is asking the guest for a name. */
  askingName: boolean;
  /** Guests connected to the link; null until the plugin reports them (plugin 0.4.0+). */
  participants: string[] | null;
  notice: string | null;
}

type Action =
  | { type: "message"; message: GuestOutbound }
  | { type: "ask_name"; asking: boolean }
  | { type: "connection"; connection: ConnectionState }
  | { type: "notice"; notice: string | null };

export const initialSessionState: GuestSessionState = {
  connection: { status: "connecting" },
  agent: null,
  status: "idle",
  items: [],
  allowPrompts: false,
  pendingApprovals: [],
  guestName: null,
  askingName: false,
  participants: null,
  notice: null,
};

export function sessionReducer(state: GuestSessionState, action: Action): GuestSessionState {
  switch (action.type) {
    case "connection":
      return {
        ...state,
        connection: action.connection,
        notice: action.connection.status === "secure" ? null : state.notice,
      };
    case "notice":
      return { ...state, notice: action.notice };
    case "ask_name":
      return { ...state, askingName: action.asking };
    case "message": {
      const message = action.message;
      switch (message.type) {
        case "welcome":
          return {
            ...state,
            agent: message.agent,
            status: message.agent.status,
            allowPrompts: message.allowPrompts,
            pendingApprovals: message.agent.pendingApprovals,
            guestName: message.guestName,
          };
        case "snapshot":
          return { ...state, items: message.items };
        case "snapshot_more":
          return { ...state, items: [...state.items, ...message.items] };
        case "item":
          return { ...state, items: applyItem(state.items, message.item) };
        case "status":
          return { ...state, status: message.status };
        case "renamed":
          return { ...state, guestName: message.guestName };
        case "approval": {
          const others = state.pendingApprovals.filter((id) => id !== message.requestId);
          return {
            ...state,
            pendingApprovals: message.pending ? [...others, message.requestId] : others,
          };
        }
        case "participants":
          return { ...state, participants: message.names };
        case "prompt_rejected":
        case "closing":
          return { ...state, notice: message.reason };
        default:
          // A newer plugin may send messages this page does not know yet.
          return state;
      }
    }
  }
}

export function useGuestSession(result: InvitationResult) {
  const invitation = result.ok ? result.invitation : null;
  const [state, dispatch] = useReducer(
    sessionReducer,
    result.ok
      ? initialSessionState
      : { ...initialSessionState, connection: { status: "ended", reason: result.reason } },
  );
  const connection = useRef<GuestConnection | null>(null);
  const nameKey = invitation ? `paseo-collab-name:${invitation.serverId}` : null;

  useEffect(() => {
    if (!invitation) return;
    const created = new GuestConnection(invitation, {
      onMessage: (message) => {
        if (message.type === "renamed" && nameKey) storeName(nameKey, message.guestName);
        dispatch({ type: "message", message });
        // Plugins before 0.3.0 cannot rename and reject the message, so only ask when offered.
        if (message.type !== "welcome" || !message.canRename) return;
        const remembered = nameKey ? readName(nameKey) : null;
        if (remembered) void created.send({ type: "set_name", name: remembered }).catch(() => {});
        else dispatch({ type: "ask_name", asking: true });
      },
      onState: (next) => dispatch({ type: "connection", connection: next }),
    });
    connection.current = created;
    created.start();
  }, [invitation]);

  const sendPrompt = useCallback(async (text: string) => {
    dispatch({ type: "notice", notice: null });
    try {
      await connection.current?.send({ type: "prompt", text });
    } catch (error) {
      dispatch({
        type: "notice",
        notice: error instanceof Error ? error.message : "Could not send the prompt.",
      });
    }
  }, []);

  const setName = useCallback(async (name: string) => {
    dispatch({ type: "ask_name", asking: false });
    await connection.current?.send({ type: "set_name", name }).catch(() => {});
  }, []);

  return { state, sendPrompt, setName };
}

/** The name chosen for this link, kept for reconnects and reloads in this tab. */
function readName(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function storeName(key: string, name: string): void {
  try {
    sessionStorage.setItem(key, name);
  } catch {
    // Storage unavailable: the guest is asked again after a reload.
  }
}
