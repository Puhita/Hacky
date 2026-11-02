// Sidebar behaviour with no VS Code dependency: turns webview messages into API calls
// and publishes the state the webview renders.
import type {
  ActiveDecision,
  BoardTask,
  FeedItem,
  HackyApi,
  InboxQuestion,
  PeerThread,
  PendingAssumption,
  PulseMember,
  Team,
} from "./api.js";
import { connectedTeamId, connectWorkspace } from "./setup.js";

const REFRESH_DEBOUNCE_MS = 300;
// Realtime can drop silently, so the sidebar also refreshes on a timer.
const FALLBACK_REFRESH_MS = 30_000;
const DIGEST_CHECK_MS = 60_000;
// The sidebar's pulse shows the last hour, whatever the digest cadence is.
const PULSE_WINDOW_MS = 60 * 60_000;

export type WorkspaceStatus = "none" | "not_connected" | "connected" | "other_team";

export type SidebarState = {
  user: { email: string } | null;
  teams: Team[];
  team: Team | null;
  workspace: WorkspaceStatus;
  inbox: InboxQuestion[];
  assumptions: PendingAssumption[];
  decisions: ActiveDecision[];
  tasks: BoardTask[];
  feed: FeedItem[];
  pulse: PulseMember[];
  agentChat: PeerThread[];
  notice: string | null;
  error: string | null;
};

export type Message =
  | { type: "ready" }
  | { type: "signIn"; email: string; password: string }
  | { type: "signUp"; email: string; password: string }
  | { type: "signOut" }
  | { type: "createTeam"; name: string; displayName: string }
  | { type: "joinTeam"; code: string; displayName: string }
  | { type: "selectTeam"; teamId: string }
  | { type: "connectWorkspace" }
  | { type: "answer"; questionId: string; text: string }
  | { type: "confirmAssumption"; assumptionId: string }
  | { type: "rejectAssumption"; assumptionId: string; reason: string }
  | { type: "changeDecision"; decisionId: string; text: string }
  | { type: "withdrawDecision"; decisionId: string }
  | { type: "addTask"; title: string }
  | { type: "answerTeammate"; questionId: string; text: string };

export type ControllerOptions = {
  api: HackyApi;
  supabaseUrl: string;
  publishableKey: string;
  workspaceDir: () => string | null;
  loadTeamId: () => string | undefined;
  saveTeamId: (teamId: string | undefined) => void;
  post: (state: SidebarState) => void;
  // How often to tell the person what teammates got done, in minutes. 0 or absent turns it off.
  digestMinutes?: () => number;
  loadDigestAt?: () => number | undefined;
  saveDigestAt?: (at: number) => void;
  // Shows a message outside the sidebar, such as a VS Code notification.
  notify?: (message: string) => void;
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

// One line per teammate who logged progress, or null when nobody did.
export function describeDigest(pulse: PulseMember[]): string | null {
  const lines = pulse
    .filter((member) => !member.me && member.updates > 0)
    .map((member) => `${member.name}: ${plural(member.updates, "update")}, latest "${member.latest[0]}"`);
  return lines.length > 0 ? `Team progress. ${lines.join(". ")}.` : null;
}

export class SidebarController {
  private notice: string | null = null;
  private error: string | null = null;
  private teamId: string | undefined;
  private subscribedTeamId: string | undefined;
  private unsubscribe: (() => void) | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private readonly timer: NodeJS.Timeout;
  private readonly digestTimer: NodeJS.Timeout;
  private lastDigestAt: number;
  // Teammate questions the person has already been told about. Null until the first look,
  // so questions that were already waiting when the sidebar opened don't each pop up.
  private knownPeerQuestions: Set<string> | null = null;

  constructor(private readonly options: ControllerOptions) {
    this.teamId = options.loadTeamId();
    this.lastDigestAt = options.loadDigestAt?.() ?? Date.now();
    this.timer = setInterval(() => void this.refresh(), FALLBACK_REFRESH_MS);
    this.timer.unref?.();
    this.digestTimer = setInterval(() => void this.digest(), DIGEST_CHECK_MS);
    this.digestTimer.unref?.();
  }

  dispose(): void {
    clearInterval(this.timer);
    clearInterval(this.digestTimer);
    clearTimeout(this.debounce);
    this.unsubscribe?.();
  }

  async handle(message: Message): Promise<void> {
    this.notice = null;
    this.error = null;
    try {
      await this.apply(message);
    } catch (error) {
      this.error = (error as Error).message;
    }
    await this.refresh();
  }

  private async apply(message: Message): Promise<void> {
    const { api } = this.options;
    switch (message.type) {
      case "ready":
        return;
      case "signIn":
        return api.signIn(message.email.trim(), message.password);
      case "signUp":
        if (!(await api.signUp(message.email.trim(), message.password))) {
          this.notice = "Check your email and open the link to confirm your account. It brings you back here to log in.";
        }
        return;
      case "signOut":
        await api.signOut();
        this.setTeam(undefined);
        return;
      case "createTeam":
        this.setTeam(await api.createTeam(message.name.trim(), message.displayName.trim()));
        return;
      case "joinTeam":
        this.setTeam(await api.joinTeam(message.code, message.displayName.trim()));
        return;
      case "selectTeam":
        this.setTeam(message.teamId);
        return;
      case "connectWorkspace":
        return this.connect();
      case "answer":
        await api.answer(message.questionId, message.text.trim());
        this.notice = "Answer sent to the waiting agents.";
        return;
      case "confirmAssumption":
        await api.confirmAssumption(message.assumptionId);
        this.notice = "Confirmed. Agents waiting on this question get it as the answer.";
        return;
      case "rejectAssumption":
        await api.rejectAssumption(message.assumptionId, message.reason.trim());
        this.notice = "Rejected. The agents on this question will be told.";
        return;
      case "changeDecision":
        await api.changeDecision(message.decisionId, message.text.trim());
        this.notice = "Decision changed. Every agent on the team will be told.";
        return;
      case "withdrawDecision":
        await api.withdrawDecision(message.decisionId);
        this.notice = "Decision withdrawn. Every agent on the team will be told, and its question is back in the inbox.";
        return;
      case "addTask":
        if (!this.teamId) throw new Error("Choose a team first.");
        return api.addTask(this.teamId, message.title.trim());
      case "answerTeammate":
        await api.answerPeerQuestion(message.questionId, message.text.trim());
        this.notice = "Answer sent to your teammate's agent.";
        return;
    }
  }

  // Tells the person what teammates logged since the last digest, at the chosen cadence.
  // Runs on a timer, so it never throws.
  async digest(): Promise<void> {
    const { api, notify } = this.options;
    const minutes = this.options.digestMinutes?.() ?? 0;
    if (!notify || minutes <= 0 || !this.teamId) return;
    if (Date.now() - this.lastDigestAt < minutes * 60_000) return;
    const since = new Date(this.lastDigestAt);
    try {
      const message = describeDigest(await api.pulse(this.teamId, since));
      this.lastDigestAt = Date.now();
      this.options.saveDigestAt?.(this.lastDigestAt);
      if (message) notify(message);
    } catch {
      // Try again on the next tick.
    }
  }

  private announceTeammateQuestions(threads: PeerThread[]): void {
    const open = threads.filter((thread) => thread.direction === "incoming" && thread.answer === null);
    const known = this.knownPeerQuestions;
    this.knownPeerQuestions = new Set(open.map((thread) => thread.id));
    if (!known) return;
    for (const thread of open) {
      if (!known.has(thread.id)) this.options.notify?.(`${thread.other}'s agent asks: ${thread.question}`);
    }
  }

  private connect(): void {
    const dir = this.options.workspaceDir();
    if (!dir) throw new Error("Open a folder first.");
    if (!this.teamId) throw new Error("Choose a team first.");
    connectWorkspace(dir, {
      supabaseUrl: this.options.supabaseUrl,
      publishableKey: this.options.publishableKey,
      teamId: this.teamId,
    });
    this.notice = "Workspace connected. Start a new Claude Code session to use Hacky.";
  }

  private setTeam(teamId: string | undefined): void {
    this.teamId = teamId;
    this.knownPeerQuestions = null;
    this.options.saveTeamId(teamId);
  }

  private workspaceStatus(team: Team | null): WorkspaceStatus {
    const dir = this.options.workspaceDir();
    if (!dir) return "none";
    const connected = connectedTeamId(dir);
    if (!connected) return "not_connected";
    return connected === team?.id ? "connected" : "other_team";
  }

  private syncSubscription(teamId: string | undefined): void {
    if (teamId === this.subscribedTeamId) return;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.subscribedTeamId = teamId;
    if (teamId) {
      this.unsubscribe = this.options.api.subscribe(teamId, () => {
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => void this.refresh(), REFRESH_DEBOUNCE_MS);
      });
    }
  }

  // Never throws: failures show up as a message in the sidebar.
  async refresh(): Promise<void> {
    const { api } = this.options;
    const state: SidebarState = {
      user: null,
      teams: [],
      team: null,
      workspace: "none",
      inbox: [],
      assumptions: [],
      decisions: [],
      tasks: [],
      feed: [],
      pulse: [],
      agentChat: [],
      notice: this.notice,
      error: this.error,
    };
    try {
      const user = await api.currentUser();
      if (user) {
        state.user = { email: user.email };
        state.teams = await api.listTeams();
        const dir = this.options.workspaceDir();
        const preferred = this.teamId ?? (dir ? (connectedTeamId(dir) ?? undefined) : undefined);
        state.team = state.teams.find((team) => team.id === preferred) ?? (state.teams.length === 1 ? state.teams[0] : null);
        if (state.team && state.team.id !== this.teamId) this.setTeam(state.team.id);
        if (state.team) {
          state.workspace = this.workspaceStatus(state.team);
          [state.inbox, state.assumptions, state.decisions, state.tasks, state.feed, state.pulse, state.agentChat] =
            await Promise.all([
              api.inbox(state.team.id),
              api.assumptions(state.team.id),
              api.decisions(state.team.id),
              api.tasks(state.team.id),
              api.feed(state.team.id),
              api.pulse(state.team.id, new Date(Date.now() - PULSE_WINDOW_MS)),
              api.peerThreads(state.team.id),
            ]);
          this.announceTeammateQuestions(state.agentChat);
        }
      }
      this.syncSubscription(state.team?.id);
    } catch (error) {
      state.error = state.error ?? (error as Error).message;
    }
    this.options.post(state);
  }
}
