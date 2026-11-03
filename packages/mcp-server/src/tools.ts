import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { redact } from "./redact.js";

const MAX_WAIT_SECONDS = 240;
const POLL_INTERVAL_MS = 3000;
const RECENT_EVENTS = 20;
const OWN_RECENT_EVENTS = 10;
// A chat that hasn't touched Hacky for this long is treated as idle: its work can be taken over
// without asking. Agents only reach Hacky between steps, so this has to be generous.
const ACTIVE_WINDOW_SECONDS = 10 * 60;
const HEARTBEAT_INTERVAL_MS = 30_000;
const PREVIOUS_SESSION_DAYS = 3;
const DEFAULT_PROGRESS_REMINDER_MS = 15 * 60_000;
const PROGRESS_REMINDER_REPEAT_MS = 5 * 60_000;
const ACTIVE_DECISIONS = 50;
// From supabase/tests/dedupe-eval.mjs: the lowest tuning paraphrase less a margin. This only
// decides what the agent gets to review, so it's set low: an extra candidate costs one more turn.
const CANDIDATE_THRESHOLD = 0.86;
const SEARCH_MINIMUM_SIMILARITY = 0.75;
const SEARCH_RESULTS = 5;
const NOT_LOGGED_IN = "Not logged in to Hacky. Log in from the Hacky sidebar in VS Code, then try again.";

type Result<T> = { data: T; error: { message: string } | null };

function unwrap<T>({ data, error }: Result<T>): T {
  if (error) throw new Error(error.message);
  return data;
}

function unwrapRequired<T>(result: Result<T>): NonNullable<T> {
  const data = unwrap(result);
  if (data === null || data === undefined) throw new Error("Hacky got an empty response from the database.");
  return data;
}

type WaiterRow = {
  question_id: string;
  questions: { text: string; status: string; decisions: { text: string } | null };
};

type MemberRow = { user_id: string; display_name: string };

type IncomingQuestion = {
  id: string;
  from_user: string;
  question: string;
  context: string | null;
  task_id: string | null;
  created_at: string;
};

type AnsweredTeammate = { id: string; to_user: string; question: string; answer: string };

type SessionRow = {
  id: string;
  user_id: string;
  focus: string | null;
  handoff: string | null;
  last_seen_at: string;
  closed_at: string | null;
};

function sessionState(session: Pick<SessionRow, "last_seen_at" | "closed_at">): "ended" | "active_now" | "idle" {
  if (session.closed_at !== null) return "ended";
  return Date.now() - Date.parse(session.last_seen_at) < ACTIVE_WINDOW_SECONDS * 1000 ? "active_now" : "idle";
}

// What check_answers looks at on each pass.
type Poll = {
  waiters: WaiterRow[];
  notices: NoticeRow[];
  teammateAnswers: AnsweredTeammate[];
  incoming: IncomingQuestion[];
  outgoingOpen: string[];
};

export type ServerOptions = {
  // How long without log_progress before tool results start reminding the agent to call it.
  progressReminderMs?: number;
};

type NoticeRow = {
  id: string;
  kind: "assumption_rejected" | "decision_changed" | "decision_withdrawn";
  about: string;
  text: string | null;
  questions: { text: string } | null;
};

const NOTICE_MESSAGES: Record<NoticeRow["kind"], (notice: NoticeRow) => string> = {
  assumption_rejected: ({ about, text }) =>
    `A human rejected the assumption "${about}". Reason: ${text}. Change anything you built on it. The question is still open, so its answer can still come through check_answers.`,
  decision_changed: ({ about, text }) =>
    `A human changed a team decision. It was "${about}" and it is now "${text}". Change anything you built on the old decision.`,
  decision_withdrawn: ({ about }) =>
    `A human withdrew the team decision "${about}". Stop relying on it and change anything you built on it. If you still need an answer, call ask.`,
};

export function createServer(
  supabase: SupabaseClient,
  teamId: string,
  { progressReminderMs = DEFAULT_PROGRESS_REMINDER_MS }: ServerOptions = {},
): { server: McpServer; endSession: () => Promise<void> } {
  const server = new McpServer({ name: "hacky", version: "0.1.0" });
  let verifiedUserId: string | undefined;

  // Each server process belongs to one agent chat, so the process is the session. Answers,
  // notices and teammate questions are delivered per session, and a later chat can take an
  // earlier one over. `lineage` is this session plus every session it has taken over.
  const sessionId = randomUUID();
  let registration: Promise<void> | undefined;
  let noticesSince = new Date().toISOString();
  let lineage: string[] = [sessionId];
  let lastHeartbeat = 0;
  let lastProgress = Date.now();
  let lastReminder = 0;
  // Teammate questions already put in front of the agent, so waiting doesn't return for them again.
  const shownTeammateQuestions = new Set<string>();

  function registerSession(): Promise<void> {
    registration ??= (async () => {
      const since = unwrap(await supabase.rpc("start_session", { target_team: teamId, new_session: sessionId }));
      noticesSince = since ?? noticesSince;
    })().catch((error) => {
      registration = undefined;
      throw error;
    });
    return registration;
  }

  // Lets teammates and the person's other chats see this one is alive.
  async function heartbeat(): Promise<void> {
    if (Date.now() - lastHeartbeat < HEARTBEAT_INTERVAL_MS) return;
    lastHeartbeat = Date.now();
    await supabase.from("agent_sessions").update({ last_seen_at: new Date().toISOString() }).eq("id", sessionId);
  }

  async function endSession(): Promise<void> {
    if (!registration) return;
    await supabase.from("agent_sessions").update({ closed_at: new Date().toISOString() }).eq("id", sessionId);
  }

  async function currentUserId(): Promise<string> {
    const { data, error } = await supabase.auth.getSession();
    const userId = data.session?.user.id;
    if (error || !userId) throw new Error(NOT_LOGGED_IN);
    if (verifiedUserId !== userId) {
      const member = unwrap(
        await supabase.from("members").select("user_id").eq("team_id", teamId).eq("user_id", userId).maybeSingle(),
      );
      if (!member) throw new Error(`You are not a member of the Hacky team ${teamId}.`);
      verifiedUserId = userId;
    }
    await registerSession();
    await heartbeat();
    return userId;
  }

  async function readWaiters(): Promise<WaiterRow[]> {
    const rows = unwrap(
      await supabase
        .from("question_waiters")
        .select("question_id, questions(text, status, decisions(text))")
        .eq("team_id", teamId)
        .in("session_id", lineage),
    );
    return rows as unknown as WaiterRow[];
  }

  // Notices are the person's, but each session is given each one once.
  async function readNotices(userId: string): Promise<NoticeRow[]> {
    const rows = unwrap(
      await supabase
        .from("notices")
        .select("id, kind, about, text, questions(text)")
        .eq("team_id", teamId)
        .eq("user_id", userId)
        .gte("created_at", noticesSince)
        .order("created_at", { ascending: true }),
    ) as unknown as NoticeRow[];
    if (rows.length === 0) return rows;
    const delivered = new Set(
      unwrapRequired(
        await supabase
          .from("notice_deliveries")
          .select("notice_id")
          .in("session_id", lineage)
          .in("notice_id", rows.map((row) => row.id)),
      ).map((row) => row.notice_id),
    );
    return rows.filter((row) => !delivered.has(row.id));
  }

  async function members(): Promise<MemberRow[]> {
    return unwrapRequired(await supabase.from("members").select("user_id, display_name").eq("team_id", teamId));
  }

  async function readIncoming(userId: string): Promise<IncomingQuestion[]> {
    return unwrapRequired(
      await supabase
        .from("peer_questions")
        .select("id, from_user, question, context, task_id, created_at")
        .eq("team_id", teamId)
        .eq("to_user", userId)
        .eq("status", "open")
        .order("created_at", { ascending: true }),
    );
  }

  async function readTeammateAnswers(userId: string): Promise<AnsweredTeammate[]> {
    return unwrapRequired(
      await supabase
        .from("peer_questions")
        .select("id, to_user, question, answer")
        .eq("team_id", teamId)
        .eq("from_user", userId)
        .in("from_session", lineage)
        .eq("status", "answered")
        .is("delivered_at", null)
        .order("answered_at", { ascending: true }),
    ) as AnsweredTeammate[];
  }

  async function readOutgoingOpen(userId: string): Promise<string[]> {
    const rows = unwrapRequired(
      await supabase
        .from("peer_questions")
        .select("id")
        .eq("team_id", teamId)
        .eq("from_user", userId)
        .in("from_session", lineage)
        .eq("status", "open"),
    );
    return rows.map((row) => row.id);
  }

  async function poll(userId: string): Promise<Poll> {
    const [waiters, notices, teammateAnswers, incoming, outgoingOpen] = await Promise.all([
      readWaiters(),
      readNotices(userId),
      readTeammateAnswers(userId),
      readIncoming(userId),
      readOutgoingOpen(userId),
    ]);
    return { waiters, notices, teammateAnswers, incoming, outgoingOpen };
  }

  async function embed(text: string): Promise<string | null> {
    try {
      const { data, error } = await supabase.functions.invoke("embed", { body: { text } });
      return error ? null : JSON.stringify(data.embedding);
    } catch {
      return null;
    }
  }

  const isAnswered = (waiter: WaiterRow) => waiter.questions.status === "answered" && waiter.questions.decisions !== null;

  // An MCP server can't wake an idle agent, so what needs its attention rides along on the
  // next tool result instead.
  async function headsUp(name: string): Promise<string[]> {
    const notes: string[] = [];
    try {
      const waiting = (await readIncoming(await currentUserId())).filter((question) => !shownTeammateQuestions.has(question.id));
      if (waiting.length > 0) {
        notes.push(
          `${waiting.length} teammate question${waiting.length === 1 ? " is" : "s are"} waiting for you. Call check_answers to read ${waiting.length === 1 ? "it" : "them"}, then answer_teammate.`,
        );
      }
    } catch {
      // The tool result matters more than the reminder.
    }
    const quietFor = Date.now() - lastProgress;
    if (name !== "log_progress" && quietFor >= progressReminderMs && Date.now() - lastReminder >= PROGRESS_REMINDER_REPEAT_MS) {
      lastReminder = Date.now();
      notes.push(
        `You haven't called log_progress for ${Math.round(quietFor / 60_000)} minutes. Record what you've finished so teammates can see it.`,
      );
    }
    return notes;
  }

  // Registers a tool whose handler returns a JSON-serializable body or throws a message for the agent.
  function tool<Shape extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: Shape,
    handler: (args: z.infer<z.ZodObject<Shape>>, signal: AbortSignal) => Promise<unknown>,
  ) {
    const run = async (args: z.infer<z.ZodObject<Shape>>, extra: { signal: AbortSignal }) => {
      try {
        const body = await handler(args, extra.signal);
        const notes = await headsUp(name);
        const result = notes.length > 0 && body !== null && typeof body === "object" && !Array.isArray(body) ? { ...body, heads_up: notes } : body;
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: (error as Error).message }], isError: true };
      }
    };
    (server.registerTool as (...args: unknown[]) => unknown)(name, { description, inputSchema }, run);
  }

  tool(
    "get_context",
    "Call at the start of a session. Returns your tasks, unclaimed tasks, active team decisions, what teammates did recently and are doing now, your own recent progress (including from your person's other chats), the questions you are waiting on, how many notices and teammate answers are ready for check_answers, and teammate questions waiting for your answer. If my_other_chats lists an idle or ended chat with a focus, handoff or open waits, it may be work you should continue: read it, and call resume_session to take it over.",
    {},
    async () => {
      const userId = await currentUserId();
      const windowStart = new Date(Date.now() - PREVIOUS_SESSION_DAYS * 86_400_000).toISOString();
      const [tasks, decisions, events, ownEvents, waiters, notices, sessions, teamMembers, incoming, teammateAnswers] = await Promise.all([
        supabase.from("tasks").select("id, title, status, files, owner_id").eq("team_id", teamId).neq("status", "done"),
        supabase
          .from("decisions")
          .select("id, text, created_at")
          .eq("team_id", teamId)
          .eq("status", "active")
          .order("created_at", { ascending: false })
          .limit(ACTIVE_DECISIONS),
        supabase
          .from("events")
          .select("summary, files, created_at, members(display_name)")
          .eq("team_id", teamId)
          .neq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(RECENT_EVENTS),
        supabase
          .from("events")
          .select("summary, files, created_at")
          .eq("team_id", teamId)
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(OWN_RECENT_EVENTS),
        readWaiters(),
        readNotices(userId),
        supabase
          .from("agent_sessions")
          .select("id, user_id, focus, handoff, last_seen_at, closed_at")
          .eq("team_id", teamId)
          .is("resumed_by", null)
          .gte("last_seen_at", windowStart)
          .order("last_seen_at", { ascending: false })
          .limit(100),
        members(),
        readIncoming(userId),
        readTeammateAnswers(userId),
      ]);
      const openTasks = unwrapRequired(tasks);
      const allSessions = unwrapRequired(sessions) as SessionRow[];
      const isLive = (session: SessionRow) =>
        session.closed_at === null && Date.now() - Date.parse(session.last_seen_at) < ACTIVE_WINDOW_SECONDS * 1000;
      const names = new Map(teamMembers.map((member) => [member.user_id, member.display_name]));

      const mine = allSessions.filter((session) => session.user_id === userId && session.id !== sessionId);
      const mineWaiting = new Map<string, string[]>();
      if (mine.length > 0) {
        const rows = unwrapRequired(
          await supabase
            .from("question_waiters")
            .select("session_id, questions(text)")
            .in("session_id", mine.map((session) => session.id)),
        ) as unknown as { session_id: string; questions: { text: string } }[];
        for (const row of rows) mineWaiting.set(row.session_id, [...(mineWaiting.get(row.session_id) ?? []), row.questions.text]);
      }

      for (const question of incoming) shownTeammateQuestions.add(question.id);
      return {
        session_id: sessionId,
        my_tasks: openTasks.filter((task) => task.owner_id === userId),
        unclaimed_tasks: openTasks.filter((task) => task.owner_id === null),
        active_decisions: unwrap(decisions),
        recent_activity: unwrap(events),
        my_recent_progress: unwrap(ownEvents),
        my_other_chats: mine.map((session) => ({
          session_id: session.id,
          state: session.closed_at !== null ? "ended" : isLive(session) ? "active_now" : "idle",
          last_seen_at: session.last_seen_at,
          focus: session.focus,
          handoff: session.handoff,
          waiting_on: mineWaiting.get(session.id) ?? [],
        })),
        teammates: teamMembers
          .filter((member) => member.user_id !== userId)
          .map((member) => {
            const live = allSessions.filter((session) => session.user_id === member.user_id && isLive(session));
            return {
              name: member.display_name,
              active_chats: live.length,
              doing: live.map((session) => session.focus).filter(Boolean),
              tasks: openTasks.filter((task) => task.owner_id === member.user_id).map((task) => task.title),
            };
          }),
        waiting_on: waiters.map((waiter) => ({
          question_id: waiter.question_id,
          question: waiter.questions.text,
          answer_ready: isAnswered(waiter),
        })),
        notices_ready: notices.length,
        teammate_answers_ready: teammateAnswers.length,
        teammate_questions_for_you: incoming.map((question) => ({
          question_id: question.id,
          from: names.get(question.from_user),
          question: question.question,
          context: question.context,
          task_id: question.task_id,
        })),
      };
    },
  );

  tool(
    "log_progress",
    "Record work you finished so teammates and their agents can see it, and so your person's next chat can continue from it. Call this when you complete a chunk of work, and at least every 15 minutes while you work. Say what you will do next. Never include secrets.",
    {
      summary: z.string().min(1).describe("What you did, in one or two sentences"),
      files: z.array(z.string()).optional().describe("Files you changed"),
      next: z.string().optional().describe("What you will do next. Shown to teammates and to whoever continues your work"),
      task_id: z.string().uuid().optional().describe("The task this work belongs to"),
    },
    async ({ summary, files = [], next, task_id }) => {
      const userId = await currentUserId();
      const event = unwrapRequired(
        await supabase
          .from("events")
          .insert({ team_id: teamId, user_id: userId, summary: redact(summary), files: files.map(redact), task_id })
          .select("id")
          .single(),
      );
      lastProgress = Date.now();
      const now = new Date().toISOString();
      unwrap(
        await supabase
          .from("agent_sessions")
          .update({ focus: redact(next ?? summary), last_progress_at: now, last_seen_at: now, ...(task_id && { task_id }) })
          .eq("id", sessionId),
      );
      return { logged: true, event_id: event.id };
    },
  );

  tool(
    "save_handoff",
    "Write notes for whoever continues your work: your person's next chat, or yourself after a restart. Call it before you stop, or when your context is getting full. Say what is done, what is half done, what you were about to do, and anything you learned that isn't in the code. Never include secrets.",
    { notes: z.string().min(1).describe("Everything the next chat needs to carry on without asking") },
    async ({ notes }) => {
      await currentUserId();
      unwrap(await supabase.from("agent_sessions").update({ handoff: redact(notes) }).eq("id", sessionId));
      return { saved: true };
    },
  );

  tool(
    "resume_session",
    "Take over an earlier chat of your person's, listed in my_other_chats by get_context, so you continue its work. You inherit its questions and answers, its notices and its notes. If the chat still looks active the call is refused: tell your person, and only pass takeover when they confirm it has stopped.",
    {
      session_id: z.string().uuid().describe("A session_id from my_other_chats"),
      takeover: z.boolean().optional().describe("Take it over even though it looks active. Only after your person confirms"),
    },
    async ({ session_id, takeover = false }) => {
      await currentUserId();
      const result = unwrapRequired(
        await supabase.rpc("resume_session", {
          old_session: session_id,
          new_session: sessionId,
          takeover,
          active_within_seconds: ACTIVE_WINDOW_SECONDS,
        }),
      ) as { status: string; focus: string | null; handoff: string | null; task_id: string | null; last_seen_at: string; since?: string };
      if (result.status === "still_active") {
        return {
          resumed: false,
          reason: `That chat was active at ${result.last_seen_at}. Ask your person whether it has stopped. If so, call resume_session again with takeover: true.`,
          focus: result.focus,
        };
      }
      lineage = [...new Set([...lineage, session_id])];
      if (result.since) noticesSince = result.since;
      const [waiters, notices, teammateAnswers] = await Promise.all([
        readWaiters(),
        readNotices(await currentUserId()),
        readTeammateAnswers(await currentUserId()),
      ]);
      return {
        resumed: true,
        task_id: result.task_id,
        focus: result.focus,
        handoff: result.handoff,
        last_seen_at: result.last_seen_at,
        waiting_on: waiters.map((waiter) => ({ question_id: waiter.question_id, question: waiter.questions.text, answer_ready: isAnswered(waiter) })),
        notices_ready: notices.length,
        teammate_answers_ready: teammateAnswers.length,
        message: "Carry on from the notes. Call check_answers for anything that arrived while that chat was closed.",
      };
    },
  );

  async function overlappingTasks(userId: string, files: string[]) {
    if (files.length === 0) return [];
    const rows = unwrap(
      await supabase
        .from("tasks")
        .select("title, files, members(display_name)")
        .eq("team_id", teamId)
        .eq("status", "in_progress")
        .neq("owner_id", userId)
        .overlaps("files", files),
    ) as unknown as { title: string; files: string[]; members: { display_name: string } | null }[];
    return rows.map((row) => ({
      title: row.title,
      owner: row.members?.display_name,
      shared_files: row.files.filter((file) => files.includes(file)),
    }));
  }

  tool(
    "claim_task",
    "Take an unclaimed task so no teammate duplicates the work. Check the result: if claimed is false, a teammate already owns it, so don't work on it. If it lists overlapping_tasks, a teammate is working on the same files, so keep your changes to them small and tell your human.",
    { task_id: z.string().uuid().describe("A task id from get_context") },
    async ({ task_id }) => {
      const userId = await currentUserId();
      // The owner_id filter makes this atomic: when two agents race, exactly one update matches.
      const claimed = unwrap(
        await supabase
          .from("tasks")
          .update({ owner_id: userId, status: "in_progress", updated_at: new Date().toISOString() })
          .eq("id", task_id)
          .eq("team_id", teamId)
          .is("owner_id", null)
          .select("id, title, status, files")
          .maybeSingle(),
      );
      if (claimed) {
        // Remember which chat took the task, so another chat of the same person claiming it can be warned.
        unwrap(await supabase.from("agent_sessions").update({ task_id }).eq("id", sessionId));
        const overlapping = await overlappingTasks(userId, claimed.files);
        return { claimed: true, task: claimed, ...(overlapping.length > 0 && { overlapping_tasks: overlapping }) };
      }

      const existing = unwrap(
        await supabase
          .from("tasks")
          .select("id, title, status, files, owner_id, members(display_name)")
          .eq("id", task_id)
          .eq("team_id", teamId)
          .maybeSingle(),
      ) as unknown as { owner_id: string; members: { display_name: string } | null; title: string } | null;
      if (!existing) throw new Error(`No task ${task_id} in this team.`);
      if (existing.owner_id === userId) {
        // The task is mine, but another of my chats may have taken it and be working on it right now.
        const others = unwrapRequired(
          await supabase
            .from("agent_sessions")
            .select("id, focus, last_seen_at, closed_at")
            .eq("team_id", teamId)
            .eq("user_id", userId)
            .eq("task_id", task_id)
            .neq("id", sessionId)
            .is("resumed_by", null)
            .order("last_seen_at", { ascending: false }),
        ) as Pick<SessionRow, "id" | "focus" | "last_seen_at" | "closed_at">[];
        if (others.length === 0) return { claimed: true, already_yours: true, task: existing };
        return {
          claimed: true,
          already_yours: true,
          task: existing,
          other_chats: others.map((session) => ({
            session_id: session.id,
            state: sessionState(session),
            last_seen_at: session.last_seen_at,
            focus: session.focus,
          })),
          warning:
            "Another of your chats already took this task, so working on it here may duplicate that work. If that chat is active_now, leave the task to it. If it is idle or ended, call resume_session with its session_id to continue from its notes.",
        };
      }
      return { claimed: false, owned_by: existing.members?.display_name, title: existing.title };
    },
  );

  tool(
    "create_task",
    "Add a task to the team board so an agent can claim it. Use it when work should be split up or tracked for the team. Never include secrets.",
    {
      title: z.string().min(1).describe("What needs doing, clear enough for a teammate's agent"),
      files: z.array(z.string()).optional().describe("Files the task is likely to touch"),
    },
    async ({ title, files = [] }) => {
      await currentUserId();
      const task = unwrapRequired(
        await supabase
          .from("tasks")
          .insert({ team_id: teamId, title: redact(title), files: files.map(redact) })
          .select("id, title, status, files")
          .single(),
      );
      return { created: true, task };
    },
  );

  tool(
    "complete_task",
    "Mark a task you own as done. Call log_progress as well to record what you did. Check the result: if completed is false, the task isn't yours to finish.",
    { task_id: z.string().uuid().describe("A task id from get_context") },
    async ({ task_id }) => {
      const userId = await currentUserId();
      const completed = unwrap(
        await supabase
          .from("tasks")
          .update({ status: "done", updated_at: new Date().toISOString() })
          .eq("id", task_id)
          .eq("team_id", teamId)
          .eq("owner_id", userId)
          .select("id, title, status")
          .maybeSingle(),
      );
      if (completed) return { completed: true, task: completed };

      const existing = unwrap(
        await supabase
          .from("tasks")
          .select("title, owner_id, members(display_name)")
          .eq("id", task_id)
          .eq("team_id", teamId)
          .maybeSingle(),
      ) as unknown as { title: string; owner_id: string | null; members: { display_name: string } | null } | null;
      if (!existing) throw new Error(`No task ${task_id} in this team.`);
      return {
        completed: false,
        title: existing.title,
        reason: existing.owner_id
          ? `It belongs to ${existing.members?.display_name}.`
          : "Nobody has claimed it. Call claim_task first.",
      };
    },
  );

  tool(
    "search_decisions",
    "Search the team's existing decisions before asking a question. Results are ranked by similar wording, which doesn't mean they answer your question, so read each one and only rely on it if it decides what you need.",
    { query: z.string().min(1).describe("What you need to know") },
    async ({ query }) => {
      await currentUserId();
      const embedding = await embed(redact(query));
      if (!embedding) throw new Error("Search is unavailable right now. Check active_decisions in get_context instead.");
      const decisions = unwrapRequired(
        await supabase.rpc("search_decisions", {
          target_team: teamId,
          query_embedding: embedding,
          minimum_similarity: SEARCH_MINIMUM_SIMILARITY,
          match_count: SEARCH_RESULTS,
        }),
      );
      return { decisions };
    },
  );

  // The teammate who owns the task in question, else one working on the same files. Never the
  // asker's own task, which would loop back to them.
  async function ownerOfWork(userId: string, taskId?: string, files?: string[]): Promise<string | null> {
    if (taskId) {
      const task = unwrap(
        await supabase.from("tasks").select("owner_id").eq("id", taskId).eq("team_id", teamId).maybeSingle(),
      );
      if (task?.owner_id && task.owner_id !== userId) return task.owner_id;
    }
    if (files?.length) {
      const overlapping = unwrap(
        await supabase
          .from("tasks")
          .select("owner_id")
          .eq("team_id", teamId)
          .eq("status", "in_progress")
          .neq("owner_id", userId)
          .overlaps("files", files)
          .limit(1)
          .maybeSingle(),
      );
      if (overlapping?.owner_id) return overlapping.owner_id;
    }
    return null;
  }

  // Who should answer: whoever owns the work, else the team lead.
  async function routeQuestion(userId: string, taskId?: string, files?: string[]): Promise<string | null> {
    const owner = await ownerOfWork(userId, taskId, files);
    if (owner) return owner;
    const lead = unwrap(
      await supabase.from("members").select("user_id").eq("team_id", teamId).eq("role", "lead").limit(1).maybeSingle(),
    );
    return lead?.user_id ?? null;
  }

  async function recordAssumption(userId: string, questionId: string, assumption?: string): Promise<void> {
    if (!assumption) return;
    unwrap(
      await supabase
        .from("assumptions")
        .insert({ team_id: teamId, question_id: questionId, user_id: userId, text: redact(assumption) }),
    );
  }

  tool(
    "ask",
    "Ask your team a question that only a human can answer, such as a product decision, a business rule, or a fact not in the code. Check the status in the result. If it is pending, collect the answer with check_answers. If it is possible_duplicates, nothing was sent yet: read the candidates, call join_question if one asks exactly the same thing, otherwise call ask again with confirmed_new. Never include secrets.",
    {
      question: z.string().min(1).describe("The question, answerable without seeing your session"),
      context: z.string().describe("What you are working on and why you need this"),
      assumption: z
        .string()
        .optional()
        .describe("What you will assume in the meantime, if the work can continue without the answer"),
      task_id: z.string().uuid().optional().describe("The task this is about, to route it to the task's owner"),
      files: z.array(z.string()).optional().describe("Files this is about, to route it to whoever is working on them"),
      confirmed_new: z
        .boolean()
        .optional()
        .describe("Set true after reading candidates from a previous call and deciding none asks the same thing"),
    },
    async ({ question, context, assumption, task_id, files, confirmed_new = false }) => {
      const userId = await currentUserId();
      const text = redact(question);
      const result = unwrapRequired(
        await supabase.rpc("ask_question", {
          target_team: teamId,
          question_text: text,
          question_context: redact(context),
          // If embedding fails the question still goes out, at the cost of a possible duplicate.
          question_embedding: await embed(text),
          target_routed_to: await routeQuestion(userId, task_id, files),
          candidate_threshold: CANDIDATE_THRESHOLD,
          confirmed_new,
          asking_session: sessionId,
        }),
      ) as { status: string; question_id: string; candidates: unknown };

      if (result.status === "possible_duplicates") {
        return {
          status: result.status,
          candidates: result.candidates,
          message:
            "Your question was not sent. Similar wording doesn't mean the same question: a different subject, audience or limit makes it a different question. If a candidate asks exactly the same thing, call join_question with its question_id. Otherwise call ask again with confirmed_new: true.",
        };
      }
      await recordAssumption(userId, result.question_id, assumption);
      return {
        status: "pending",
        question_id: result.question_id,
        message: "Sent to your team. Call check_answers for the reply.",
      };
    },
  );

  tool(
    "join_question",
    "Wait on a question a teammate's agent already asked, when ask returned it as a candidate and it asks exactly the same thing as yours. You get the same answer when it arrives through check_answers. If it has already been answered, the answer is returned here.",
    {
      question_id: z.string().uuid().describe("The question_id of the candidate"),
      assumption: z
        .string()
        .optional()
        .describe("What you will assume in the meantime, if the work can continue without the answer"),
    },
    async ({ question_id, assumption }) => {
      const userId = await currentUserId();
      const question = unwrap(
        await supabase
          .from("questions")
          .select("text, status, decisions(text, status)")
          .eq("id", question_id)
          .eq("team_id", teamId)
          .maybeSingle(),
      ) as unknown as { text: string; status: string; decisions: { text: string; status: string } | null } | null;
      if (!question) throw new Error(`No question ${question_id} in this team.`);
      if (question.status === "answered") {
        if (question.decisions?.status !== "active") {
          throw new Error("That question's answer was withdrawn. Call ask again with confirmed_new: true.");
        }
        return { status: "answered", question: question.text, answer: question.decisions.text };
      }
      unwrap(
        await supabase
          .from("question_waiters")
          .upsert(
            { team_id: teamId, question_id, user_id: userId, session_id: sessionId },
            { onConflict: "question_id,user_id,session_id", ignoreDuplicates: true },
          ),
      );
      await recordAssumption(userId, question_id, assumption);
      return { status: "pending", question_id, message: "You'll get the answer through check_answers." };
    },
  );

  // Resolves who a direct question goes to: the named teammate, else the owner of the task or files.
  async function resolveTeammate(userId: string, to?: string, taskId?: string, files?: string[]): Promise<MemberRow> {
    const others = (await members()).filter((member) => member.user_id !== userId);
    if (to) {
      const wanted = to.trim().toLowerCase();
      const matches = others.filter((member) => member.display_name.toLowerCase() === wanted);
      if (matches.length === 1) return matches[0];
      const names = others.map((member) => member.display_name).join(", ");
      throw new Error(
        matches.length > 1
          ? `More than one teammate is called ${to}. Teammates: ${names}.`
          : `No teammate called ${to}. Teammates: ${names || "none yet"}.`,
      );
    }
    const owner = await ownerOfWork(userId, taskId, files);
    const match = others.find((member) => member.user_id === owner);
    if (!match) {
      throw new Error("Name the teammate in `to`, or pass a task_id or files that a teammate is working on. get_context lists teammates.");
    }
    return match;
  }

  tool(
    "ask_teammate",
    "Ask a teammate's agent directly, when your task depends on work they own and only they or their agent can tell you, such as the shape of an API they are building or a file they are about to change. Do not use it for product decisions or business rules: those need a human, so use ask. Give `to` (a name from get_context), or a task_id or files to reach whoever owns them. The answer comes through check_answers. If your work can continue without it, carry on and check between steps. Never include secrets.",
    {
      question: z.string().min(1).describe("The question, answerable without seeing your session"),
      context: z.string().describe("What you are building and why you need this"),
      to: z.string().optional().describe("The teammate's name, as in get_context"),
      task_id: z.string().uuid().optional().describe("The task this is about, to reach its owner"),
      files: z.array(z.string()).optional().describe("Files this is about, to reach whoever is working on them"),
    },
    async ({ question, context, to, task_id, files }) => {
      const userId = await currentUserId();
      const target = await resolveTeammate(userId, to, task_id, files);
      const row = unwrapRequired(
        await supabase
          .from("peer_questions")
          .insert({
            team_id: teamId,
            from_user: userId,
            from_session: sessionId,
            to_user: target.user_id,
            task_id,
            question: redact(question),
            context: redact(context),
          })
          .select("id")
          .single(),
      );
      const live = unwrapRequired(
        await supabase
          .from("agent_sessions")
          .select("id")
          .eq("team_id", teamId)
          .eq("user_id", target.user_id)
          .is("closed_at", null)
          .gte("last_seen_at", new Date(Date.now() - ACTIVE_WINDOW_SECONDS * 1000).toISOString())
          .limit(1),
      );
      return {
        status: "pending",
        question_id: row.id,
        asked: target.display_name,
        message:
          live.length > 0
            ? `Sent to ${target.display_name}'s agent. Call check_answers for the reply.`
            : `${target.display_name} has no active chat right now. The question waits in their Hacky sidebar and for their next chat. Carry on with an assumption if you can, and call check_answers later.`,
      };
    },
  );

  tool(
    "answer_teammate",
    "Answer a teammate's question that check_answers or get_context showed you. Answer from what you know: your task, your code and the decisions. If you can't, ask your own person, or answer that you don't know so the asker can go elsewhere. Never include secrets.",
    {
      question_id: z.string().uuid().describe("The question_id of the teammate's question"),
      answer: z.string().min(1).describe("Your answer, usable without seeing your session"),
    },
    async ({ question_id, answer }) => {
      await currentUserId();
      unwrap(
        await supabase.rpc("answer_peer_question", {
          target_question: question_id,
          answer_text: redact(answer),
          answering_session: sessionId,
        }),
      );
      return { answered: true };
    },
  );

  const hasNews = (state: Poll) =>
    state.notices.length > 0 ||
    state.waiters.some(isAnswered) ||
    state.teammateAnswers.length > 0 ||
    state.incoming.some((question) => !shownTeammateQuestions.has(question.id));
  const isWaitingOnSomething = (state: Poll) => state.waiters.length > 0 || state.outgoingOpen.length > 0;

  tool(
    "check_answers",
    "Get answers to the questions you asked with ask or ask_teammate, list the ones still pending, get notices that a human rejected an assumption or changed a decision, and get questions teammates asked you. Each answer, notice and teammate question is returned once. A notice overrides your earlier work. If an answer differs from your_assumption, change what you built on the assumption. Answer each teammate_question with answer_teammate. Pass wait_seconds to hold the call open until something arrives or the time runs out. Waiting uses no tokens, but you can't do anything else meanwhile, so only wait when your work depends on the answer.",
    {
      wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional().describe("How long to wait for an answer"),
    },
    async ({ wait_seconds = 0 }, signal) => {
      const userId = await currentUserId();
      const deadline = Date.now() + wait_seconds * 1000;
      let state = await poll(userId);
      while (!hasNews(state) && isWaitingOnSomething(state) && Date.now() < deadline && !signal.aborted) {
        await sleep(POLL_INTERVAL_MS, undefined, { signal }).catch(() => {});
        if (!signal.aborted) state = await poll(userId);
      }

      const { waiters, notices, teammateAnswers, outgoingOpen } = state;
      const answered = waiters.filter(isAnswered);
      const assumed = new Map<string, string>();
      if (answered.length > 0) {
        const questionIds = answered.map((waiter) => waiter.question_id);
        const assumptions = unwrapRequired(
          await supabase
            .from("assumptions")
            .select("question_id, text")
            .eq("user_id", userId)
            .neq("status", "rejected")
            .in("question_id", questionIds),
        );
        for (const assumption of assumptions) assumed.set(assumption.question_id, assumption.text);
        unwrap(await supabase.from("question_waiters").delete().in("session_id", lineage).in("question_id", questionIds));
      }
      if (notices.length > 0) {
        unwrap(
          await supabase
            .from("notice_deliveries")
            .upsert(
              notices.map((notice) => ({ notice_id: notice.id, session_id: sessionId })),
              { onConflict: "notice_id,session_id", ignoreDuplicates: true },
            ),
        );
      }
      if (teammateAnswers.length > 0) {
        unwrap(
          await supabase
            .from("peer_questions")
            .update({ delivered_at: new Date().toISOString() })
            .in("id", teammateAnswers.map((item) => item.id)),
        );
      }
      const newQuestions = state.incoming.filter((question) => !shownTeammateQuestions.has(question.id));
      for (const question of newQuestions) shownTeammateQuestions.add(question.id);

      const names = new Map((await members()).map((member) => [member.user_id, member.display_name]));
      return {
        answers: answered.map((waiter) => ({
          question_id: waiter.question_id,
          question: waiter.questions.text,
          answer: waiter.questions.decisions?.text,
          ...(assumed.has(waiter.question_id) && { your_assumption: assumed.get(waiter.question_id) }),
        })),
        notices: notices.map((notice) => ({
          kind: notice.kind,
          question: notice.questions?.text,
          message: NOTICE_MESSAGES[notice.kind](notice),
        })),
        still_pending: waiters.filter((waiter) => !isAnswered(waiter)).map((waiter) => waiter.question_id),
        ...(teammateAnswers.length > 0 && {
          teammate_answers: teammateAnswers.map((item) => ({
            question_id: item.id,
            from: names.get(item.to_user),
            question: item.question,
            answer: item.answer,
          })),
        }),
        ...(newQuestions.length > 0 && {
          teammate_questions: newQuestions.map((question) => ({
            question_id: question.id,
            from: names.get(question.from_user),
            question: question.question,
            context: question.context,
            task_id: question.task_id,
          })),
        }),
        ...(outgoingOpen.length > 0 && { still_pending_teammates: outgoingOpen }),
      };
    },
  );

  return { server, endSession };
}
