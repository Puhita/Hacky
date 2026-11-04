import type { SidebarState } from "./controller.js";

// How many things are waiting for this person: questions sent to them, and questions from a
// teammate's agent that nobody has answered. The sidebar, the activity bar badge and the
// status bar all show this one number.
export function attentionCount(state: Pick<SidebarState, "inbox" | "agentChat">): number {
  return (
    state.inbox.filter((question) => question.routed_to_me).length +
    state.agentChat.filter((thread) => thread.direction === "incoming" && thread.answer === null).length
  );
}

export function statusText(count: number): string {
  return count === 0 ? "Hacky · all clear" : `Hacky · ${count} need you`;
}
