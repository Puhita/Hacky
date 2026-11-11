// Sidebar behaviour with no VS Code dependency: turns webview messages into API calls
// and publishes the state the webview renders.
import type {
  ActiveDecision,
  BoardTask,
  FeedItem,
  HackyApi,
  InboxQuestion,
  MapState,
  PeerThread,
  PendingAssumption,
  PulseMember,
  Team,
  TeamMember,
  TeamSkill,
  TaskArea,
  FileTouch,
  ProjectItemKind,
  ProjectItemStatus,
  ProjectState,
  BugSeverity,
} from "./api.js";
import { MIN_PASSWORD_LENGTH } from "./api.js";
import { readGit, type GitGraph } from "./gitTree.js";
import { installedSkill, installSkill, lookUpSkill, parseGithubUrl, previewPicked, removeSkill, type Fetch, type SkillLookup } from "./skills.js";
import { connectedTeamId, connectWorkspace, EDITORS, managedBlockIsCurrent, type Editor } from "./setup.js";

const REFRESH_DEBOUNCE_MS = 300;
// Realtime can drop silently, so the sidebar also refreshes on a timer.
const FALLBACK_REFRESH_MS = 30_000;
const DIGEST_CHECK_MS = 60_000;
// The sidebar's pulse shows the last hour, whatever the digest cadence is.
const PULSE_WINDOW_MS = 60 * 60_000;

// outdated: connected to this team, but the Hacky block in CLAUDE.md is from an older version.
// How one folder stands against a team: not connected, connected to another team, outdated or current.
export function folderStatus(dir: string | null, teamId: string | undefined): WorkspaceStatus {
  if (!dir) return "none";
  const connected = connectedTeamId(dir);
  if (!connected) return "not_connected";
  if (connected !== teamId) return "other_team";
  return managedBlockIsCurrent(dir) ? "connected" : "outdated";
}

export type WorkspaceStatus = "none" | "not_connected" | "connected" | "outdated" | "other_team";

// How a team skill stands in this person's active folder.
export type SkillLocal = "none" | "current" | "outdated" | "manual";
export type SkillsState = {
  team: (TeamSkill & { local: SkillLocal })[];
  // What the person is looking at before installing: a list to choose from, or one skill's preview.
  lookup: SkillLookup | null;
  // True when the preview is a teammate's skill, which is already on the team list.
  fromTeam: boolean;
};

// The Git screen's data. It is read when the screen asks, not on every refresh, because running git is slow.
export type GitState = { status: "idle" | "ok" | "error"; error: string | null; graph: GitGraph | null; loadedAt: number | null };

export type SidebarState = {
  // displayName is the name teammates see: the one given when joining or creating a group, or changed in the profile.
  user: { email: string; displayName: string | null } | null;
  teams: Team[];
  team: Team | null;
  // Everyone in the current group, with their roles.
  members: TeamMember[];
  workspace: WorkspaceStatus;
  inbox: InboxQuestion[];
  assumptions: PendingAssumption[];
  decisions: ActiveDecision[];
  tasks: BoardTask[];
  // The project page: shared overview, ideas and bugs.
  project: ProjectState;
  // Files agents reported editing in the last week.
  fileTouches: FileTouch[];
  feed: FeedItem[];
  pulse: PulseMember[];
  agentChat: PeerThread[];
  skills: SkillsState;
  git: GitState;
  // What the Hacky Map draws. Empty until the first refresh for a team.
  map: MapState;
  notice: string | null;
  error: string | null;
};

export type Message =
  | { type: "ready" }
  | { type: "signIn"; email: string; password: string }
  | { type: "signUp"; email: string; password: string; confirmPassword: string }
  | { type: "signOut" }
  | { type: "createTeam"; name: string; displayName: string }
  | { type: "joinTeam"; code: string; displayName: string }
  | { type: "selectTeam"; teamId: string }
  | { type: "connectWorkspace"; editors?: Editor[] }
  | { type: "answer"; questionId: string; text: string }
  | { type: "confirmAssumption"; assumptionId: string }
  | { type: "rejectAssumption"; assumptionId: string; reason: string }
  | { type: "changeDecision"; decisionId: string; text: string }
  | { type: "withdrawDecision"; decisionId: string }
  | { type: "addTask"; title: string; area?: TaskArea }
  | { type: "saveOverview"; idea: string; architecture: string }
  | { type: "addProjectItem"; kind: ProjectItemKind; title: string; details?: string; severity?: BugSeverity }
  | { type: "setProjectItemStatus"; itemId: string; status: ProjectItemStatus }
  | { type: "projectItemToTask"; itemId: string }
  | { type: "answerTeammate"; questionId: string; text: string }
  | { type: "renameTeam"; name: string }
  | { type: "deleteTeam" }
  | { type: "leaveTeam" }
  | { type: "regenerateInvite" }
  | { type: "removeMember"; userId: string }
  | { type: "setRole"; userId: string; role: "lead" | "member" }
  | { type: "updateProfile"; displayName: string }
  | { type: "changePassword"; password: string; confirmPassword: string }
  | { type: "previewSkill"; url: string }
  | { type: "pickSkill"; path: string }
  | { type: "previewTeamSkill"; skillId: string }
  | { type: "installSkill"; share?: boolean }
  | { type: "cancelSkill" }
  | { type: "unshareSkill"; skillId: string }
  | { type: "removeLocalSkill"; name: string }
  | { type: "openMap" }
  | { type: "openBoard" }
  | { type: "openSkills" }
  | { type: "openGit" }
  | { type: "loadGit" };

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
  // Replaces the network call used to look skills up on GitHub. Tests pass a fake.
  fetch?: Fetch;
  // Opens the Hacky Map in an editor tab.
  openMap?: () => void;
  // Opens the Hacky Board (tasks, messages, team, activity) in an editor tab.
  openBoard?: () => void;
  // Opens the Skills screen in an editor tab.
  openSkills?: () => void;
  // Opens the Git screen in an editor tab.
  openGit?: () => void;
};

// Both boxes must agree, and the password must be long enough for the account service to take it.
export function checkNewPassword(password: string, confirmPassword: string): void {
  if (password !== confirmPassword) throw new Error("The two passwords don't match.");
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`The password needs at least ${MIN_PASSWORD_LENGTH} characters.`);
}

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
  private skillLookup: SkillLookup | null = null;
  private skillFromTeam = false;
  private git: GitState = { status: "idle", error: null, graph: null, loadedAt: null };
  private lastState: SidebarState | null = null;

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
        checkNewPassword(message.password, message.confirmPassword);
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
        return this.connect(message.editors);
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
      case "saveOverview":
        if (!this.teamId) throw new Error("Choose a team first.");
        await api.saveOverview(this.teamId, message.idea, message.architecture);
        this.notice = "Overview saved. Agents see the start of it when they begin a session.";
        return;
      case "addProjectItem":
        if (!this.teamId) throw new Error("Choose a team first.");
        if (message.title.trim() === "") throw new Error("Give it a title.");
        return api.addProjectItem(this.teamId, message.kind, message.title.trim(), (message.details ?? "").trim(), message.severity);
      case "setProjectItemStatus":
        return api.setProjectItemStatus(message.itemId, message.status);
      case "projectItemToTask":
        await api.projectItemToTask(message.itemId);
        this.notice = "Added to the board as a task.";
        return;
      case "addTask":
        if (!this.teamId) throw new Error("Choose a team first.");
        return api.addTask(this.teamId, message.title.trim(), message.area || undefined);
      case "answerTeammate":
        await api.answerPeerQuestion(message.questionId, message.text.trim());
        this.notice = "Answer sent to your teammate's agent.";
        return;
      case "renameTeam":
        await api.renameTeam(this.requireTeam(), message.name.trim());
        this.notice = "Group renamed.";
        return;
      case "deleteTeam":
        await api.deleteTeam(this.requireTeam());
        this.setTeam(undefined);
        this.notice = "Group deleted.";
        return;
      case "leaveTeam":
        await api.leaveTeam(this.requireTeam());
        this.setTeam(undefined);
        this.notice = "You left the group.";
        return;
      case "regenerateInvite":
        await api.regenerateInviteCode(this.requireTeam());
        this.notice = "New invite code. The old one no longer works.";
        return;
      case "removeMember":
        await api.removeMember(this.requireTeam(), message.userId);
        this.notice = "Removed from the group.";
        return;
      case "setRole":
        await api.setMemberRole(this.requireTeam(), message.userId, message.role);
        return;
      case "updateProfile":
        await api.setDisplayName(message.displayName.trim());
        this.notice = "Name saved.";
        return;
      case "changePassword":
        checkNewPassword(message.password, message.confirmPassword);
        await api.changePassword(message.password);
        this.notice = "Password changed.";
        return;
      case "previewSkill": {
        this.skillFromTeam = false;
        this.skillLookup = await lookUpSkill(parseGithubUrl(message.url), this.githubFetch());
        return;
      }
      case "pickSkill": {
        const lookup = this.skillLookup;
        if (lookup?.kind !== "choose" || !lookup.candidates.some((candidate) => candidate.path === message.path)) throw new Error("Choose one of the listed skills.");
        this.skillLookup = { kind: "preview", preview: await previewPicked(lookup.repo, lookup.sha, message.path, this.githubFetch()) };
        return;
      }
      case "previewTeamSkill": {
        const skill = (await api.teamSkills(this.requireTeam())).find((row) => row.id === message.skillId);
        if (!skill) throw new Error("That skill is no longer on the team list.");
        this.skillFromTeam = true;
        this.skillLookup = { kind: "preview", preview: await previewPicked(skill.repo, skill.sha, skill.path, this.githubFetch()) };
        return;
      }
      case "installSkill": {
        const lookup = this.skillLookup;
        if (lookup?.kind !== "preview") throw new Error("Look a skill up first.");
        const dir = this.options.workspaceDir();
        if (!dir) throw new Error("Choose a folder first.");
        const { preview } = lookup;
        await installSkill(dir, preview, this.githubFetch());
        if (message.share && !this.skillFromTeam) {
          await api.shareSkill(this.requireTeam(), { name: preview.name, repo: preview.repo, path: preview.path, sha: preview.sha });
        }
        this.skillLookup = null;
        this.notice = `Installed ${preview.name}. Start a new chat in your tool to use it.`;
        return;
      }
      case "cancelSkill":
        this.skillLookup = null;
        return;
      case "unshareSkill":
        await api.unshareSkill(message.skillId);
        this.notice = "Removed from the team list. Copies already installed stay where they are.";
        return;
      case "removeLocalSkill": {
        const dir = this.options.workspaceDir();
        if (!dir) throw new Error("Choose a folder first.");
        removeSkill(dir, message.name);
        this.notice = `Removed ${message.name} from this folder.`;
        return;
      }
      case "openMap":
        this.options.openMap?.();
        return;
      case "openBoard":
        this.options.openBoard?.();
        return;
      case "openSkills":
        this.options.openSkills?.();
        return;
      case "openGit":
        this.options.openGit?.();
        return;
      case "loadGit": {
        const dir = this.options.workspaceDir();
        if (!dir) {
          this.git = { status: "error", error: "Choose a project folder first.", graph: null, loadedAt: null };
          return;
        }
        try {
          this.git = { status: "ok", error: null, graph: await readGit(dir), loadedAt: Date.now() };
        } catch (error) {
          this.git = { status: "error", error: (error as Error).message, graph: null, loadedAt: null };
        }
        // Show it now, rather than after the full refresh that follows every message.
        if (this.lastState) this.options.post({ ...this.lastState, git: this.git });
        return;
      }
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

  private githubFetch(): Fetch {
    return (
      this.options.fetch ??
      ((url) => fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "hacky-skills" } }) as ReturnType<Fetch>)
    );
  }

  // The team's skills, each with how it stands in the active folder.
  private async skillsState(teamId: string): Promise<SkillsState> {
    let rows: TeamSkill[] = [];
    try {
      rows = await this.options.api.teamSkills(teamId);
    } catch {
      // The list is optional; a failure here shouldn't hide the rest of the app.
    }
    const dir = this.options.workspaceDir();
    const team = rows.map((row) => {
      const found = dir ? installedSkill(dir, row.name) : null;
      const local: SkillLocal = found === null ? "none" : found === "manual" ? "manual" : found.sha === row.sha ? "current" : "outdated";
      return { ...row, local };
    });
    return { team, lookup: this.skillLookup, fromTeam: this.skillFromTeam };
  }

  private connect(requested?: Editor[]): void {
    const dir = this.options.workspaceDir();
    if (!dir) throw new Error("Open a folder first.");
    if (!this.teamId) throw new Error("Choose a team first.");
    // Messages come from a web page, so only known tool names get through.
    const editors = requested === undefined ? undefined : EDITORS.filter((editor) => requested.includes(editor));
    connectWorkspace(
      dir,
      { supabaseUrl: this.options.supabaseUrl, publishableKey: this.options.publishableKey, teamId: this.teamId },
      process.platform,
      editors,
    );
    this.notice = "Workspace connected. Start a new chat in your tool to use Hacky.";
  }

  private requireTeam(): string {
    if (!this.teamId) throw new Error("Choose a group first.");
    return this.teamId;
  }

  private setTeam(teamId: string | undefined): void {
    this.teamId = teamId;
    this.knownPeerQuestions = null;
    this.options.saveTeamId(teamId);
  }

  private workspaceStatus(team: Team | null): WorkspaceStatus {
    return folderStatus(this.options.workspaceDir(), team?.id);
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
      members: [],
      workspace: "none",
      inbox: [],
      assumptions: [],
      decisions: [],
      tasks: [],
      project: { overview: { idea: "", architecture: "", updatedBy: null, updatedAt: null }, items: [] },
      fileTouches: [],
      feed: [],
      pulse: [],
      agentChat: [],
      skills: { team: [], lookup: null, fromTeam: false },
      git: this.git,
      map: {
        project: "",
        owners: [],
        chats: [],
        threads: [],
        unassigned: [],
        decisions: [],
        stats: { tasks: { todo: 0, in_progress: 0, done: 0 }, openQuestions: 0, decisions: 0, activeChats: 0 },
        timeline: { from: "", items: [] },
      },
      notice: this.notice,
      error: this.error,
    };
    try {
      const user = await api.currentUser();
      if (user) {
        state.user = { email: user.email, displayName: await api.displayName() };
        state.teams = await api.listTeams();
        const dir = this.options.workspaceDir();
        const preferred = this.teamId ?? (dir ? (connectedTeamId(dir) ?? undefined) : undefined);
        state.team = state.teams.find((team) => team.id === preferred) ?? (state.teams.length === 1 ? state.teams[0] : null);
        if (state.team && state.team.id !== this.teamId) this.setTeam(state.team.id);
        if (state.team) {
          state.workspace = this.workspaceStatus(state.team);
          [state.inbox, state.assumptions, state.decisions, state.tasks, state.feed, state.pulse, state.agentChat, state.map, state.members] =
            await Promise.all([
              api.inbox(state.team.id),
              api.assumptions(state.team.id),
              api.decisions(state.team.id),
              api.tasks(state.team.id),
              api.feed(state.team.id),
              api.pulse(state.team.id, new Date(Date.now() - PULSE_WINDOW_MS)),
              api.peerThreads(state.team.id),
              api.mapState(state.team.id),
              api.teamMembers(state.team.id),
            ]);
          state.project = await api.projectState(state.team.id);
          state.fileTouches = await api.fileTouches(state.team.id);
          state.skills = await this.skillsState(state.team.id);
          this.announceTeammateQuestions(state.agentChat);
        }
      }
      this.syncSubscription(state.team?.id);
    } catch (error) {
      state.error = state.error ?? (error as Error).message;
    }
    this.lastState = state;
    this.options.post(state);
  }
}
