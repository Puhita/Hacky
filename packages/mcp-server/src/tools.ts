import { setTimeout as sleep } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { redact } from "./redact.js";

const MAX_WAIT_SECONDS = 240;
const POLL_INTERVAL_MS = 3000;
const RECENT_EVENTS = 20;
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

export function createServer(supabase: SupabaseClient, teamId: string): McpServer {
  const server = new McpServer({ name: "hacky", version: "0.0.0" });
  let verifiedUserId: string | undefined;

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
    return userId;
  }

  async function readWaiters(userId: string): Promise<WaiterRow[]> {
    const rows = unwrap(
      await supabase
        .from("question_waiters")
        .select("question_id, questions(text, status, decisions(text))")
        .eq("team_id", teamId)
        .eq("user_id", userId),
    );
    return rows as unknown as WaiterRow[];
  }

  async function readNotices(userId: string): Promise<NoticeRow[]> {
    const rows = unwrap(
      await supabase
        .from("notices")
        .select("id, kind, about, text, questions(text)")
        .eq("team_id", teamId)
        .eq("user_id", userId)
        .order("created_at", { ascending: true }),
    );
    return rows as unknown as NoticeRow[];
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

  // Registers a tool whose handler returns a JSON-serializable body or throws a message for the agent.
  function tool<Shape extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: Shape,
    handler: (args: z.infer<z.ZodObject<Shape>>, signal: AbortSignal) => Promise<unknown>,
  ) {
    const run = async (args: z.infer<z.ZodObject<Shape>>, extra: { signal: AbortSignal }) => {
      try {
        return { content: [{ type: "text" as const, text: JSON.stringify(await handler(args, extra.signal)) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: (error as Error).message }], isError: true };
      }
    };
    (server.registerTool as (...args: unknown[]) => unknown)(name, { description, inputSchema }, run);
  }

  tool(
    "get_context",
    "Call at the start of a session. Returns your tasks, unclaimed tasks, active team decisions, what teammates did recently, the questions you are waiting on, and how many notices are ready for check_answers.",
    {},
    async () => {
      const userId = await currentUserId();
      const [tasks, decisions, events, waiters, notices] = await Promise.all([
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
        readWaiters(userId),
        readNotices(userId),
      ]);
      const openTasks = unwrapRequired(tasks);
      return {
        my_tasks: openTasks.filter((task) => task.owner_id === userId),
        unclaimed_tasks: openTasks.filter((task) => task.owner_id === null),
        active_decisions: unwrap(decisions),
        recent_activity: unwrap(events),
        waiting_on: waiters.map((waiter) => ({
          question_id: waiter.question_id,
          question: waiter.questions.text,
          answer_ready: isAnswered(waiter),
        })),
        notices_ready: notices.length,
      };
    },
  );

  tool(
    "log_progress",
    "Record work you finished so teammates and their agents can see it. Call this when you complete a chunk of work. Never include secrets.",
    {
      summary: z.string().min(1).describe("What you did, in one or two sentences"),
      files: z.array(z.string()).optional().describe("Files you changed"),
    },
    async ({ summary, files = [] }) => {
      const userId = await currentUserId();
      const event = unwrapRequired(
        await supabase
          .from("events")
          .insert({ team_id: teamId, user_id: userId, summary: redact(summary), files: files.map(redact) })
          .select("id")
          .single(),
      );
      return { logged: true, event_id: event.id };
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
      if (existing.owner_id === userId) return { claimed: true, already_yours: true, task: existing };
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

  // Who should answer: the owner of the task in question, else a teammate working on the
  // same files, else the team lead. Never the asker's own task, which would loop back to them.
  async function routeQuestion(userId: string, taskId?: string, files?: string[]): Promise<string | null> {
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
          .upsert({ team_id: teamId, question_id, user_id: userId }, { onConflict: "question_id,user_id", ignoreDuplicates: true }),
      );
      await recordAssumption(userId, question_id, assumption);
      return { status: "pending", question_id, message: "You'll get the answer through check_answers." };
    },
  );

  tool(
    "check_answers",
    "Get answers to the questions you asked with ask, list the ones still pending, and get notices that a human rejected an assumption or changed a decision. Each answer and notice is returned once. A notice overrides your earlier work. If an answer differs from your_assumption, change what you built on the assumption. Pass wait_seconds to hold the call open until an answer or notice arrives or the time runs out. Waiting uses no tokens, but you can't do anything else meanwhile, so only wait when your work depends on the answer.",
    {
      wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional().describe("How long to wait for an answer"),
    },
    async ({ wait_seconds = 0 }, signal) => {
      const userId = await currentUserId();
      const deadline = Date.now() + wait_seconds * 1000;
      let [waiters, notices] = await Promise.all([readWaiters(userId), readNotices(userId)]);
      while (
        notices.length === 0 &&
        waiters.length > 0 &&
        !waiters.some(isAnswered) &&
        Date.now() < deadline &&
        !signal.aborted
      ) {
        await sleep(POLL_INTERVAL_MS, undefined, { signal }).catch(() => {});
        if (!signal.aborted) [waiters, notices] = await Promise.all([readWaiters(userId), readNotices(userId)]);
      }

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
        unwrap(await supabase.from("question_waiters").delete().eq("user_id", userId).in("question_id", questionIds));
      }
      if (notices.length > 0) {
        unwrap(await supabase.from("notices").delete().in("id", notices.map((notice) => notice.id)));
      }
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
      };
    },
  );

  return server;
}
