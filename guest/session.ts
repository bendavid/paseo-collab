import { useCallback, useEffect, useReducer, useRef } from "react";
import type {
  GuestAgent,
  GuestAgentStatus,
  GuestItem,
  GuestOutbound,
} from "../shared/guest-protocol";
import { type ConnectionState, GuestConnection } from "./connection";
import { applyItem, type InvitationResult } from "./timeline";

export interface GuestSessionState {
  connection: ConnectionState;
  agent: GuestAgent | null;
  status: GuestAgentStatus;
  items: GuestItem[];
  allowPrompts: boolean;
  includeCode: boolean;
  pendingApprovals: string[];
  /** This guest's own name, so its prompts can read as "You". */
  guestName: string | null;
  notice: string | null;
}

type Action =
  | { type: "message"; message: GuestOutbound }
  | { type: "connection"; connection: ConnectionState }
  | { type: "notice"; notice: string | null };

export const initialSessionState: GuestSessionState = {
  connection: { status: "connecting" },
  agent: null,
  status: "idle",
  items: [],
  allowPrompts: false,
  includeCode: false,
  pendingApprovals: [],
  guestName: null,
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
    case "message": {
      const message = action.message;
      switch (message.type) {
        case "welcome":
          return {
            ...state,
            agent: message.agent,
            status: message.agent.status,
            allowPrompts: message.allowPrompts,
            includeCode: message.includeCode,
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
        case "approval": {
          const others = state.pendingApprovals.filter((id) => id !== message.requestId);
          return {
            ...state,
            pendingApprovals: message.pending ? [...others, message.requestId] : others,
          };
        }
        case "prompt_rejected":
        case "closing":
          return { ...state, notice: message.reason };
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

  useEffect(() => {
    if (!invitation) return;
    const created = new GuestConnection(invitation, {
      onMessage: (message) => dispatch({ type: "message", message }),
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

  return { state, sendPrompt };
}
