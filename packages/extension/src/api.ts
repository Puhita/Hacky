// Everything the sidebar reads and writes. Runs as the signed-in user, so RLS applies.
import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import { fileStorage } from "hacky-mcp-server/credentials";
import { redact } from "hacky-mcp-server/redact";

const FEED_LIMIT = 30;
const DECISION_LIMIT = 50;
const TASK_LIMIT = 200;
const LIVE_TABLES = ["events", "questions", "question_waiters", "decisions", "tasks", "assumptions", "agent_sessions", "peer_questions"];
const PEER_THREAD_LIMIT = 20;
// Matches the MCP server: a chat that hasn't touched Hacky for this long counts as idle.
const ACTIVE_WINDOW_MS = 10 * 60_000;
const PULSE_LATEST = 3;

// Where the confirmation email's link lands. It opens the user's editor, so nothing has to be
// hosted. Each URL must be in the project's allowed redirects, see supabase/config.toml.
export const confirmationUrl = (uriScheme: string) => `${uriScheme}://hacky.hacky/confirmed`;

export type Team = { id: string; name: string; invite_code: string; role: string };
export type InboxQuestion = {
  id: string;
  text: string;
  context: string | null;
  created_at: string;
  asked_by_name: string;
  routed_to_me: boolean;
  waiting: number;
};
export type FeedItem = { id: string; summary: string; files: string[]; created_at: string; author: string };
export type PendingAssumption = { id: string; text: string; created_at: string; question: string; author: string };
export type ActiveDecision = { id: string; text: string; created_at: string; question: string | null; author: string };
export type BoardTask = { id: string; title: string; status: string; files: string[]; owner: string | null };
// A question between two people's agents, seen from the signed-in person.
export type PeerThread = {
  id: string;
  direction: "incoming" | "outgoing";
  other: string;
  question: string;
  context: string | null;
  answer: string | null;
  answered_by_agent: boolean;
  created_at: string;
};
// What a teammate's agents have been doing since a moment in time.
export type PulseMember = {
  name: string;
  me: boolean;
  chats: number;
  focus: string[];
  updates: number;
  latest: string[];
};

function unwrap<T>({ data, error }: { data: T; error: { message: string } | null }): NonNullable<T> {
  if (error) throw new Error(error.message);
  return data as NonNullable<T>;
}

export class HackyApi {
  private readonly supabase: SupabaseClient;

  constructor(
    url: string,
    publishableKey: string,
    credentialsFile: string,
    private readonly emailRedirectTo?: string,
  ) {
    // The session lives in the same file the MCP server reads, so logging in here logs agents in.
    this.supabase = createClient(url, publishableKey, {
      auth: {
        storage: fileStorage(credentialsFile),
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    });
  }

  async currentUser(): Promise<{ id: string; email: string } | null> {
    const { data, error } = await this.supabase.auth.getSession();
    const user = data.session?.user;
    return error || !user ? null : { id: user.id, email: user.email ?? "" };
  }

  async signIn(email: string, password: string): Promise<void> {
    const { error } = await this.supabase.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
  }

  // Returns false when the project requires the user to confirm their email first.
  async signUp(email: string, password: string): Promise<boolean> {
    const { data, error } = await this.supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: this.emailRedirectTo },
    });
    if (error) throw new Error(error.message);
    return data.session !== null;
  }

  async signOut(): Promise<void> {
    const { error } = await this.supabase.auth.signOut({ scope: "local" });
    if (error) throw new Error(error.message);
  }

  async listTeams(): Promise<Team[]> {
    const user = await this.currentUser();
    if (!user) return [];
    const rows = unwrap(
      await this.supabase.from("members").select("role, teams(id, name, invite_code)").eq("user_id", user.id),
    ) as unknown as { role: string; teams: Omit<Team, "role"> }[];
    return rows.map((row) => ({ ...row.teams, role: row.role }));
  }

  async createTeam(name: string, displayName: string): Promise<string> {
    const team = unwrap(await this.supabase.rpc("create_team", { team_name: name, member_name: displayName }));
    return team.id;
  }

  async joinTeam(code: string, displayName: string): Promise<string> {
    return unwrap(await this.supabase.rpc("join_team", { code: code.trim(), member_name: displayName }));
  }

  async inbox(teamId: string): Promise<InboxQuestion[]> {
    const user = await this.currentUser();
    const rows = unwrap(
      await this.supabase
        .from("questions")
        .select(
          "id, text, context, created_at, routed_to, asker:members!questions_team_id_asked_by_fkey(display_name), question_waiters(count)",
        )
        .eq("team_id", teamId)
        .eq("status", "open")
        .order("created_at", { ascending: true }),
    ) as unknown as {
      id: string;
      text: string;
      context: string | null;
      created_at: string;
      routed_to: string | null;
      asker: { display_name: string } | null;
      question_waiters: { count: number }[];
    }[];
    return rows
      .map((row) => ({
        id: row.id,
        text: row.text,
        context: row.context,
        created_at: row.created_at,
        asked_by_name: row.asker?.display_name ?? "A teammate",
        routed_to_me: row.routed_to === user?.id,
        waiting: row.question_waiters[0]?.count ?? 0,
      }))
      .sort((a, b) => Number(b.routed_to_me) - Number(a.routed_to_me));
  }

  async feed(teamId: string): Promise<FeedItem[]> {
    const rows = unwrap(
      await this.supabase
        .from("events")
        .select("id, summary, files, created_at, members(display_name)")
        .eq("team_id", teamId)
        .order("created_at", { ascending: false })
        .limit(FEED_LIMIT),
    ) as unknown as (Omit<FeedItem, "author"> & { members: { display_name: string } | null })[];
    return rows.map(({ members, ...row }) => ({ ...row, author: members?.display_name ?? "A teammate" }));
  }

  async answer(questionId: string, text: string): Promise<void> {
    await this.embedDecision(
      unwrap(await this.supabase.rpc("answer_question", { target_question: questionId, answer: redact(text) })),
    );
  }

  // Makes the decision searchable. The decision is already saved, so a failure here only means
  // it won't appear in search_decisions, and it isn't worth showing the user an error for.
  private async embedDecision(decisionId: string): Promise<void> {
    const { data: decision } = await this.supabase
      .from("decisions")
      .select("text, questions(text)")
      .eq("id", decisionId)
      .maybeSingle();
    if (!decision) return;
    const question = (decision.questions as unknown as { text: string }[])[0]?.text ?? "";
    const { data, error } = await this.supabase.functions.invoke("embed", { body: { text: `${question}\n${decision.text}` } });
    if (error) return;
    await this.supabase.from("decisions").update({ embedding: JSON.stringify(data.embedding) }).eq("id", decisionId);
  }

  async assumptions(teamId: string): Promise<PendingAssumption[]> {
    const rows = unwrap(
      await this.supabase
        .from("assumptions")
        .select("id, text, created_at, members(display_name), questions!inner(text, status)")
        .eq("team_id", teamId)
        .eq("status", "pending")
        .eq("questions.status", "open")
        .order("created_at", { ascending: true }),
    ) as unknown as {
      id: string;
      text: string;
      created_at: string;
      members: { display_name: string } | null;
      questions: { text: string };
    }[];
    return rows.map((row) => ({
      id: row.id,
      text: row.text,
      created_at: row.created_at,
      question: row.questions.text,
      author: row.members?.display_name ?? "A teammate",
    }));
  }

  async confirmAssumption(assumptionId: string): Promise<void> {
    await this.embedDecision(unwrap(await this.supabase.rpc("confirm_assumption", { target_assumption: assumptionId })));
  }

  async rejectAssumption(assumptionId: string, reason: string): Promise<void> {
    unwrap(await this.supabase.rpc("reject_assumption", { target_assumption: assumptionId, reason: redact(reason) }));
  }

  async decisions(teamId: string): Promise<ActiveDecision[]> {
    const rows = unwrap(
      await this.supabase
        .from("decisions")
        .select("id, text, created_at, members(display_name), questions(text)")
        .eq("team_id", teamId)
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(DECISION_LIMIT),
    ) as unknown as {
      id: string;
      text: string;
      created_at: string;
      members: { display_name: string } | null;
      questions: { text: string }[];
    }[];
    return rows.map((row) => ({
      id: row.id,
      text: row.text,
      created_at: row.created_at,
      question: row.questions[0]?.text ?? null,
      author: row.members?.display_name ?? "A teammate",
    }));
  }

  async changeDecision(decisionId: string, text: string): Promise<void> {
    await this.embedDecision(
      unwrap(await this.supabase.rpc("change_decision", { target_decision: decisionId, new_text: redact(text) })),
    );
  }

  async withdrawDecision(decisionId: string): Promise<void> {
    unwrap(await this.supabase.rpc("change_decision", { target_decision: decisionId, new_text: null }));
  }

  async tasks(teamId: string): Promise<BoardTask[]> {
    const rows = unwrap(
      await this.supabase
        .from("tasks")
        .select("id, title, status, files, members(display_name)")
        .eq("team_id", teamId)
        .order("created_at", { ascending: true })
        .limit(TASK_LIMIT),
    ) as unknown as (Omit<BoardTask, "owner"> & { members: { display_name: string } | null })[];
    return rows.map(({ members, ...row }) => ({ ...row, owner: members?.display_name ?? null }));
  }

  async addTask(teamId: string, title: string): Promise<void> {
    unwrap(await this.supabase.from("tasks").insert({ team_id: teamId, title: redact(title) }));
  }

  private async memberNames(teamId: string): Promise<Map<string, string>> {
    const rows = unwrap(await this.supabase.from("members").select("user_id, display_name").eq("team_id", teamId));
    return new Map(rows.map((row) => [row.user_id, row.display_name]));
  }

  // Questions between agents that involve this person, newest first.
  async peerThreads(teamId: string): Promise<PeerThread[]> {
    const user = await this.currentUser();
    if (!user) return [];
    const [names, rows] = await Promise.all([
      this.memberNames(teamId),
      this.supabase
        .from("peer_questions")
        .select("id, from_user, to_user, question, context, answer, answered_by_session, created_at")
        .eq("team_id", teamId)
        .order("created_at", { ascending: false })
        .limit(PEER_THREAD_LIMIT)
        .then(unwrap),
    ]);
    return rows.map((row) => {
      const incoming = row.to_user === user.id;
      return {
        id: row.id,
        direction: incoming ? "incoming" : "outgoing",
        other: names.get(incoming ? row.from_user : row.to_user) ?? "A teammate",
        question: row.question,
        context: row.context,
        answer: row.answer,
        answered_by_agent: row.answered_by_session !== null,
        created_at: row.created_at,
      };
    });
  }

  // The person answers for their agents, for example when none of them is running.
  async answerPeerQuestion(questionId: string, text: string): Promise<void> {
    unwrap(
      await this.supabase.rpc("answer_peer_question", {
        target_question: questionId,
        answer_text: redact(text),
        answering_session: null,
      }),
    );
  }

  // Who is doing what: live chats and their focus, and the progress logged since `since`.
  async pulse(teamId: string, since: Date): Promise<PulseMember[]> {
    const user = await this.currentUser();
    const [names, events, sessions] = await Promise.all([
      this.memberNames(teamId),
      this.supabase
        .from("events")
        .select("user_id, summary, created_at")
        .eq("team_id", teamId)
        .gte("created_at", since.toISOString())
        .order("created_at", { ascending: false })
        .then(unwrap),
      this.supabase
        .from("agent_sessions")
        .select("user_id, focus")
        .eq("team_id", teamId)
        .is("closed_at", null)
        .gte("last_seen_at", new Date(Date.now() - ACTIVE_WINDOW_MS).toISOString())
        .order("last_seen_at", { ascending: false })
        .then(unwrap),
    ]);
    return [...names].map(([userId, name]) => {
      const mine = events.filter((event) => event.user_id === userId);
      const live = sessions.filter((session) => session.user_id === userId);
      return {
        name,
        me: userId === user?.id,
        chats: live.length,
        focus: live.map((session) => session.focus).filter((focus): focus is string => Boolean(focus)),
        updates: mine.length,
        latest: mine.slice(0, PULSE_LATEST).map((event) => event.summary),
      };
    });
  }

  // Calls onChange whenever a teammate or agent changes anything the sidebar shows.
  subscribe(teamId: string, onChange: () => void): () => void {
    let channel: RealtimeChannel = this.supabase.channel(`team-${teamId}`);
    for (const table of LIVE_TABLES) {
      channel = channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table, filter: `team_id=eq.${teamId}` },
        onChange,
      );
    }
    channel.subscribe();
    return () => {
      void this.supabase.removeChannel(channel);
    };
  }

  async dispose(): Promise<void> {
    await this.supabase.removeAllChannels();
    await this.supabase.auth.stopAutoRefresh();
  }
}
