import type { Link } from "../shared/links";

/** What an agent's Collab pill shows. */
export interface PillState {
  active: boolean;
  guests: number;
}

export const IDLE_PILL: PillState = { active: false, guests: 0 };

/** One state per agent with a live link; agents without one are idle. */
export function pillStates(links: readonly Link[]): Map<string, PillState> {
  return new Map(
    links.map((link) => [link.agentId, { active: true, guests: link.participants.length }]),
  );
}

export function pillLabel(state: PillState): string {
  return state.active && state.guests > 0 ? `Collab · ${state.guests}` : "Collab";
}

export function pillTitle(state: PillState): string {
  if (!state.active) return "Collaborate through a link";
  if (state.guests === 0) return "Link active, no guests connected";
  return state.guests === 1
    ? "Link active, 1 guest connected"
    : `Link active, ${state.guests} guests connected`;
}

export function samePillState(a: PillState, b: PillState): boolean {
  return a.active === b.active && a.guests === b.guests;
}

type Listener = () => void;
const listeners = new Set<Listener>();

/** Lets the popover ask the pills to refresh right after it creates or stops a link. */
export function onLinksChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyLinksChanged(): void {
  for (const listener of listeners) listener();
}
