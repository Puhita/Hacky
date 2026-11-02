// Sidebar behaviour with no VS Code dependency: turns webview messages into API calls
// and publishes the state the webview renders.
import type { FeedItem, HackyApi, InboxQuestion, Team } from "./api.js";
import { connectedTeamId, connectWorkspace } from "./setup.js";

const REFRESH_DEBOUNCE_MS = 300;
// Realtime can drop silently, so the sidebar also refreshes on a timer.
const FALLBACK_REFRESH_MS = 30_000;

export type WorkspaceStatus = "none" | "not_connected" | "connected" | "other_team";

export type SidebarState = {
  user: { email: string } | null;
  teams: Team[];
  team: Team | null;
  workspace: WorkspaceStatus;
  inbox: InboxQuestion[];
  feed: FeedItem[];
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
  | { type: "answer"; questionId: string; text: string };

export type ControllerOptions = {
  api: HackyApi;
  supabaseUrl: string;
  publishableKey: string;
  workspaceDir: () => string | null;
  loadTeamId: () => string | undefined;
  saveTeamId: (teamId: string | undefined) => void;
  post: (state: SidebarState) => void;
};

export class SidebarController {
  private notice: string | null = null;
  private error: string | null = null;
  private teamId: string | undefined;
  private subscribedTeamId: string | undefined;
  private unsubscribe: (() => void) | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly options: ControllerOptions) {
    this.teamId = options.loadTeamId();
    this.timer = setInterval(() => void this.refresh(), FALLBACK_REFRESH_MS);
    this.timer.unref?.();
  }

  dispose(): void {
    clearInterval(this.timer);
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
          this.notice = "Check your email to confirm your account, then log in.";
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
      feed: [],
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
          [state.inbox, state.feed] = await Promise.all([api.inbox(state.team.id), api.feed(state.team.id)]);
        }
      }
      this.syncSubscription(state.team?.id);
    } catch (error) {
      state.error = state.error ?? (error as Error).message;
    }
    this.options.post(state);
  }
}
