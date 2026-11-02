// Several chats per account, handoff between them, progress and questions between agents,
// through the built server and the linked Supabase project.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { fileStorage } from "./credentials.js";

const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY } = process.env as Record<string, string>;
const SERVER = join(dirname(fileURLToPath(import.meta.url)), "index.js");
const admin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const tempDir = mkdtempSync(join(tmpdir(), "hacky-sessions-test-"));
const userIds: string[] = [];
const teamIds: string[] = [];
const clients: Client[] = [];

type User = { supabase: SupabaseClient; userId: string; credentials: string; name: string };

async function createUser(name: string): Promise<User> {
  const email = `hacky-test-${name.toLowerCase()}-${randomBytes(6).toString("hex")}@example.com`;
  const password = randomBytes(24).toString("hex");
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(error);
  userIds.push(data.user!.id);
  const credentials = join(tempDir, `${name}.json`);
  const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { storage: fileStorage(credentials), persistSession: true, autoRefreshToken: false },
  });
  const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
  assert.ifError(signInError);
  return { supabase, userId: data.user!.id, credentials, name };
}

// Each call is a new chat: a new server process, so a new session, on the same account.
async function chat(user: User, teamId: string, env: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: {
        HACKY_SUPABASE_URL: SUPABASE_URL,
        HACKY_SUPABASE_PUBLISHABLE_KEY: SUPABASE_PUBLISHABLE_KEY,
        HACKY_TEAM_ID: teamId,
        HACKY_CREDENTIALS_FILE: user.credentials,
        ...env,
      },
    }),
  );
  clients.push(client);
  return client;
}

async function raw(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  return { text: (result.content as { text: string }[])[0].text, isError: Boolean(result.isError) };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const { text, isError } = await raw(client, name, args);
  assert.ok(!isError, `${name} failed: ${text}`);
  return JSON.parse(text);
}

let lead: User, bob: User;

before(async () => {
  [lead, bob] = await Promise.all(["Lead", "Bob"].map(createUser));
});

after(async () => {
  for (const client of clients) await client.close().catch(() => {});
  for (const id of teamIds) await admin.from("teams").delete().eq("id", id);
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
  rmSync(tempDir, { recursive: true, force: true });
});

async function newTeam() {
  const { data: team, error } = await lead.supabase.rpc("create_team", { team_name: "Sessions", member_name: "Lead" });
  assert.ifError(error);
  teamIds.push(team.id);
  const joined = await bob.supabase.rpc("join_team", { code: team.invite_code, member_name: "Bob" });
  assert.ifError(joined.error);
  return team.id as string;
}

async function until(condition: () => Promise<boolean>, label: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const QUESTION = "What should the session timeout be?";

test("two chats on one account each get the answer, not just whichever asks first", async () => {
  const teamId = await newTeam();
  const first = await chat(bob, teamId);
  const second = await chat(bob, teamId);
  const asked = await call(first, "ask", { question: QUESTION, context: "Auth" });
  await call(second, "get_context");
  const joined = await call(second, "join_question", { question_id: asked.question_id });
  assert.equal(joined.status, "pending");
  const { data: waiters } = await admin.from("question_waiters").select("session_id").eq("question_id", asked.question_id);
  assert.equal(new Set(waiters!.map((row) => row.session_id)).size, 2, "one wait per chat");

  const decision = await lead.supabase.rpc("answer_question", { target_question: asked.question_id, answer: "37 minutes" });
  assert.ifError(decision.error);
  for (const agent of [first, second]) {
    const { answers } = await call(agent, "check_answers");
    assert.equal(answers.length, 1, "each chat is given the answer");
    assert.equal(answers[0].answer, "37 minutes");
    assert.deepEqual((await call(agent, "check_answers")).answers, [], "once per chat");
  }
});

test("a rejected assumption notifies each of the person's chats once", async () => {
  const teamId = await newTeam();
  const first = await chat(bob, teamId);
  const second = await chat(bob, teamId);
  await Promise.all([call(first, "get_context"), call(second, "get_context")]);
  const asked = await call(first, "ask", { question: QUESTION, context: "Auth", assumption: "30 minutes" });
  const { data: assumption } = await admin.from("assumptions").select("id").eq("question_id", asked.question_id).single();
  const rejected = await lead.supabase.rpc("reject_assumption", { target_assumption: assumption!.id, reason: "Use 37" });
  assert.ifError(rejected.error);

  assert.equal((await call(first, "get_context")).notices_ready, 1);
  assert.equal((await call(second, "get_context")).notices_ready, 1, "the other chat hasn't taken it");
  for (const agent of [first, second]) {
    assert.equal((await call(agent, "check_answers")).notices.length, 1);
    assert.deepEqual((await call(agent, "check_answers")).notices, []);
  }
});

test("a new chat sees an earlier chat's handoff and waits, and resuming gives it the answer", async () => {
  const teamId = await newTeam();
  const earlierChat = await chat(bob, teamId);
  const { session_id } = await call(earlierChat, "get_context");
  const asked = await call(earlierChat, "ask", { question: QUESTION, context: "Auth" });
  await call(earlierChat, "log_progress", { summary: "Built the login form", next: "Wire up the session timeout" });
  await call(earlierChat, "save_handoff", { notes: "Form is done. The timeout needs the answer to the question." });
  await earlierChat.close();
  // A closed stdin marks the session ended. If the process was killed instead, it just goes quiet,
  // and after the active window it is idle. Either way it can be taken over without a prompt.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await admin.from("agent_sessions").update({ last_seen_at: new Date(Date.now() - 3_600_000).toISOString() }).eq("id", session_id);

  const decision = await lead.supabase.rpc("answer_question", { target_question: asked.question_id, answer: "37 minutes" });
  assert.ifError(decision.error);

  const laterChat = await chat(bob, teamId);
  const context = await call(laterChat, "get_context");
  assert.equal(context.my_other_chats.length, 1);
  const earlier = context.my_other_chats[0];
  assert.equal(earlier.session_id, session_id);
  assert.ok(["ended", "idle"].includes(earlier.state), earlier.state);
  assert.equal(earlier.focus, "Wire up the session timeout");
  assert.match(earlier.handoff, /timeout needs the answer/);
  assert.deepEqual(earlier.waiting_on, [QUESTION]);
  assert.ok(context.my_recent_progress.some((item: { summary: string }) => item.summary === "Built the login form"));
  assert.deepEqual((await call(laterChat, "check_answers")).answers, [], "the answer belongs to the earlier chat until it is taken over");

  const resumed = await call(laterChat, "resume_session", { session_id });
  assert.equal(resumed.resumed, true);
  assert.match(resumed.handoff, /Form is done/);
  assert.equal(resumed.waiting_on[0].answer_ready, true);
  const { answers } = await call(laterChat, "check_answers");
  assert.equal(answers[0].answer, "37 minutes");

  const again = await call(await chat(bob, teamId), "get_context");
  assert.ok(!again.my_other_chats.some((item: { session_id: string }) => item.session_id === session_id), "a taken-over chat isn't offered again");
});

test("a chat that is still active isn't taken over unless the person confirms", async () => {
  const teamId = await newTeam();
  const running = await chat(bob, teamId);
  const { session_id } = await call(running, "get_context");
  const next = await chat(bob, teamId);
  const refused = await call(next, "resume_session", { session_id });
  assert.equal(refused.resumed, false);
  assert.match(refused.reason, /takeover: true/);
  assert.equal((await call(next, "resume_session", { session_id, takeover: true })).resumed, true);
  const { text, isError } = await raw(await chat(lead, teamId), "resume_session", { session_id });
  assert.ok(isError && /no such session/.test(text), "only the person's own chats can be resumed");
});

test("an agent asks a teammate's agent, who answers, and the answer arrives once", async () => {
  const teamId = await newTeam();
  const asker = await chat(lead, teamId);
  const answerer = await chat(bob, teamId);
  await call(answerer, "get_context");

  const asked = await call(asker, "ask_teammate", {
    to: "bob",
    question: "Which fields does GET /users return?",
    context: "Building the profile page",
  });
  assert.equal(asked.status, "pending");
  assert.match(asked.message, /Sent to Bob's agent/);

  // The recipient hears about it on its next tool call, even if it never asks.
  const nudge = await call(answerer, "log_progress", { summary: "Started the users endpoint" });
  assert.match(nudge.heads_up[0], /teammate question/);
  const { teammate_questions } = await call(answerer, "check_answers");
  assert.equal(teammate_questions.length, 1);
  assert.equal(teammate_questions[0].from, "Lead");
  assert.equal(teammate_questions[0].question, "Which fields does GET /users return?");
  assert.equal((await call(answerer, "check_answers")).teammate_questions, undefined, "shown once");
  assert.equal((await call(answerer, "log_progress", { summary: "More work" })).heads_up, undefined, "no more nagging once seen");

  const pending = await call(asker, "check_answers");
  assert.deepEqual(pending.still_pending_teammates, [asked.question_id]);

  await call(answerer, "answer_teammate", { question_id: asked.question_id, answer: "id, name and email" });
  const reply = await call(asker, "check_answers");
  assert.equal(reply.teammate_answers[0].from, "Bob");
  assert.equal(reply.teammate_answers[0].answer, "id, name and email");
  assert.equal((await call(asker, "check_answers")).teammate_answers, undefined, "delivered once");

  const second = await raw(answerer, "answer_teammate", { question_id: asked.question_id, answer: "again" });
  assert.ok(second.isError && /no longer open/.test(second.text));
});

test("waiting in check_answers returns when a teammate's answer arrives", async () => {
  const teamId = await newTeam();
  const asker = await chat(lead, teamId);
  const asked = await call(asker, "ask_teammate", { to: "Bob", question: "Is the database seeded?", context: "Testing" });
  const held = call(asker, "check_answers", { wait_seconds: 60 });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const answering = await bob.supabase.rpc("answer_peer_question", {
    target_question: asked.question_id,
    answer_text: "Yes, 20 users",
    answering_session: null,
  });
  assert.ifError(answering.error);
  const reply = await held;
  assert.equal(reply.teammate_answers[0].answer, "Yes, 20 users");
});

test("ask_teammate reaches a task's owner, and refuses unknown names, yourself and unowned work", async () => {
  const teamId = await newTeam();
  const asker = await chat(lead, teamId);
  const bobAgent = await chat(bob, teamId);
  const { task } = await call(bobAgent, "create_task", { title: "Users API" });
  await call(bobAgent, "claim_task", { task_id: task.id });

  const viaTask = await call(asker, "ask_teammate", { task_id: task.id, question: "Is it paginated?", context: "Listing" });
  assert.equal(viaTask.asked, "Bob");
  const unknown = await raw(asker, "ask_teammate", { to: "Nobody", question: "?", context: "-" });
  assert.ok(unknown.isError && /No teammate called Nobody\. Teammates: Bob/.test(unknown.text));
  const self = await raw(asker, "ask_teammate", { to: "Lead", question: "?", context: "-" });
  assert.ok(self.isError, "can't ask yourself");
  const unowned = await raw(asker, "ask_teammate", { question: "?", context: "-" });
  assert.ok(unowned.isError && /Name the teammate/.test(unowned.text));
});

test("teammate questions and answers are private to the two people", async () => {
  const teamId = await newTeam();
  const asker = await chat(lead, teamId);
  const asked = await call(asker, "ask_teammate", { to: "Bob", question: "Secret?", context: "-" });
  const outsider = await createUser("Outsider");
  assert.deepEqual((await outsider.supabase.from("peer_questions").select("id")).data, []);
  const hijack = await outsider.supabase.rpc("answer_peer_question", {
    target_question: asked.question_id,
    answer_text: "no",
    answering_session: null,
  });
  assert.ok(hijack.error);
});

test("log_progress shows teammates what a chat is doing, and a quiet chat is reminded to log", async () => {
  const teamId = await newTeam();
  const worker = await chat(bob, teamId, { HACKY_PROGRESS_REMINDER_SECONDS: "1" });
  const watcher = await chat(lead, teamId);
  await call(worker, "log_progress", { summary: "Finished the form", next: "Validation next" });
  const view = await call(watcher, "get_context");
  const bobView = view.teammates.find((item: { name: string }) => item.name === "Bob");
  assert.equal(bobView.active_chats, 1);
  assert.deepEqual(bobView.doing, ["Validation next"]);

  await new Promise((resolve) => setTimeout(resolve, 1500));
  const reminder = await call(worker, "get_context");
  assert.match(reminder.heads_up.join(" "), /log_progress for \d+ minutes/);
  assert.equal((await call(worker, "get_context")).heads_up, undefined, "not repeated straight away");
  assert.equal((await call(worker, "log_progress", { summary: "Validation" })).heads_up, undefined);
});
