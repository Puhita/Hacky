// Everything the sidebar reads and writes. Runs as the signed-in user, so RLS applies.
import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import { fileStorage } from "hacky-mcp-server/credentials";
import { redact } from "hacky-mcp-server/redact";

const FEED_LIMIT = 30;
const LIVE_TABLES = ["events", "questions", "question_waiters", "decisions", "tasks"];

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

function unwrap<T>({ data, error }: { data: T; error: { message: string } | null }): NonNullable<T> {
  if (error) throw new Error(error.message);
  return data as NonNullable<T>;
}

export class HackyApi {
  private readonly supabase: SupabaseClient;

  constructor(url: string, publishableKey: string, credentialsFile: string) {
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
    const { data, error } = await this.supabase.auth.signUp({ email, password });
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
    const answer = redact(text);
    const decisionId = unwrap(await this.supabase.rpc("answer_question", { target_question: questionId, answer }));
    await this.embedDecision(decisionId, questionId, answer);
  }

  // Makes the decision searchable. The answer is already saved, so a failure here only means
  // it won't appear in search_decisions, and it isn't worth showing the user an error for.
  private async embedDecision(decisionId: string, questionId: string, answer: string): Promise<void> {
    const { data: question } = await this.supabase.from("questions").select("text").eq("id", questionId).maybeSingle();
    const { data, error } = await this.supabase.functions.invoke("embed", {
      body: { text: `${question?.text ?? ""}\n${answer}` },
    });
    if (error) return;
    await this.supabase.from("decisions").update({ embedding: JSON.stringify(data.embedding) }).eq("id", decisionId);
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
