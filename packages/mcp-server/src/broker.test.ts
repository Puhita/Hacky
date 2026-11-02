// The decision broker, through the built server and the linked Supabase project.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
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

const tempDir = mkdtempSync(join(tmpdir(), "hacky-broker-test-"));
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

async function connect(user: User, teamId: string): Promise<Client> {
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
      },
    }),
  );
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  const text = (result.content as { text: string }[])[0].text;
  assert.ok(!result.isError, `${name} failed: ${text}`);
  return JSON.parse(text);
}

let lead: User, bob: User, carol: User, outsider: User;

before(async () => {
  [lead, bob, carol, outsider] = await Promise.all(["Lead", "Bob", "Carol", "Outsider"].map(createUser));
});

after(async () => {
  for (const client of clients) await client.close();
  for (const id of teamIds) await admin.from("teams").delete().eq("id", id);
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
  rmSync(tempDir, { recursive: true, force: true });
});

// A fresh team per test, so earlier questions can't show up as candidates.
async function newTeam() {
  const { data: team, error } = await lead.supabase.rpc("create_team", { team_name: "Broker", member_name: "Lead" });
  assert.ifError(error);
  teamIds.push(team.id);
  for (const user of [bob, carol]) {
    const joined = await user.supabase.rpc("join_team", { code: team.invite_code, member_name: user.name });
    assert.ifError(joined.error);
  }
  const [leadAgent, bobAgent, carolAgent] = await Promise.all([lead, bob, carol].map((user) => connect(user, team.id)));
  return { teamId: team.id as string, leadAgent, bobAgent, carolAgent };
}

const waiterIds = async (questionId: string) => {
  const { data } = await admin.from("question_waiters").select("user_id").eq("question_id", questionId);
  return data!.map((row) => row.user_id).sort();
};
const questionCount = async (teamId: string) => {
  const { count } = await admin.from("questions").select("*", { count: "exact", head: true }).eq("team_id", teamId);
  return count;
};

const QUESTION = "What should the session timeout be?";
const PARAPHRASE = "What session timeout value should we use for logged in users?";

test("three agents become one question with three waiters, and one answer reaches all three", async () => {
  const { teamId, leadAgent, bobAgent, carolAgent } = await newTeam();
  const first = await call(bobAgent, "ask", { question: QUESTION, context: "Auth" });
  assert.equal(first.status, "pending");

  for (const [agent, user] of [[carolAgent, carol], [leadAgent, lead]] as const) {
    const second = await call(agent, "ask", { question: PARAPHRASE, context: "Auth" });
    assert.equal(second.status, "possible_duplicates");
    assert.equal(second.candidates[0].question_id, first.question_id);
    assert.equal(second.candidates[0].question, QUESTION);
    assert.ok(second.candidates[0].similarity >= 0.86);
    assert.equal((await call(agent, "join_question", { question_id: first.question_id })).status, "pending");
    assert.ok((await waiterIds(first.question_id)).includes(user.userId));
  }
  assert.equal(await questionCount(teamId), 1);
  assert.equal((await waiterIds(first.question_id)).length, 3);

  const answered = await lead.supabase.rpc("answer_question", { target_question: first.question_id, answer: "37 minutes" });
  assert.ifError(answered.error);
  for (const agent of [bobAgent, carolAgent, leadAgent]) {
    assert.equal((await call(agent, "check_answers")).answers[0].answer, "37 minutes");
    assert.deepEqual((await call(agent, "check_answers")).answers, []);
  }
});

test("a candidate is never merged without the agent's choice, and confirmed_new keeps them apart", async () => {
  const { teamId, bobAgent, carolAgent } = await newTeam();
  const first = await call(bobAgent, "ask", { question: "What's the minimum password length?", context: "Auth" });
  const near = await call(carolAgent, "ask", { question: "What's the maximum password length?", context: "Auth", assumption: "128" });
  assert.equal(near.status, "possible_duplicates");
  assert.equal(await questionCount(teamId), 1, "nothing is created until the agent decides");
  assert.deepEqual(await waiterIds(first.question_id), [bob.userId]);
  const { count: assumptions } = await admin.from("assumptions").select("*", { count: "exact", head: true }).eq("team_id", teamId);
  assert.equal(assumptions, 0);

  const second = await call(carolAgent, "ask", { question: "What's the maximum password length?", context: "Auth", assumption: "128", confirmed_new: true });
  assert.equal(second.status, "pending");
  assert.notEqual(second.question_id, first.question_id);
  assert.equal(await questionCount(teamId), 2);
  const { data: stored } = await admin.from("assumptions").select("text").eq("question_id", second.question_id);
  assert.deepEqual(stored, [{ text: "128" }]);
});

test("agents asking at the same moment create one question, not several", async () => {
  const { teamId, leadAgent, bobAgent, carolAgent } = await newTeam();
  const results = await Promise.all(
    [leadAgent, bobAgent, carolAgent].map((agent) => call(agent, "ask", { question: QUESTION, context: "Auth" })),
  );
  assert.equal(results.filter((result) => result.status === "pending").length, 1);
  assert.equal(results.filter((result) => result.status === "possible_duplicates").length, 2);
  assert.equal(await questionCount(teamId), 1);
});

test("an already answered candidate shows its answer, and joining returns it without waiting", async () => {
  const { bobAgent, carolAgent } = await newTeam();
  const first = await call(bobAgent, "ask", { question: QUESTION, context: "Auth" });
  await lead.supabase.rpc("answer_question", { target_question: first.question_id, answer: "37 minutes" });

  const again = await call(carolAgent, "ask", { question: PARAPHRASE, context: "Auth" });
  assert.equal(again.candidates[0].status, "answered");
  assert.equal(again.candidates[0].answer, "37 minutes");
  const joined = await call(carolAgent, "join_question", { question_id: first.question_id });
  assert.deepEqual(joined, { status: "answered", question: QUESTION, answer: "37 minutes" });
  assert.ok(!(await waiterIds(first.question_id)).includes(carol.userId));
});

test("a superseded answer isn't offered as a candidate", async () => {
  const { bobAgent, carolAgent } = await newTeam();
  const first = await call(bobAgent, "ask", { question: QUESTION, context: "Auth" });
  const { data: decisionId } = await lead.supabase.rpc("answer_question", { target_question: first.question_id, answer: "37 minutes" });
  await lead.supabase.from("decisions").update({ status: "superseded" }).eq("id", decisionId);
  const joined = await carolAgent.callTool({ name: "join_question", arguments: { question_id: first.question_id } });
  assert.ok(joined.isError, "a withdrawn answer isn't handed out");
  assert.ok(!JSON.stringify(joined.content).includes("37 minutes"));
  assert.equal((await call(carolAgent, "ask", { question: PARAPHRASE, context: "Auth" })).status, "pending");
});

test("joining twice is harmless, and an unknown question is an error", async () => {
  const { bobAgent, carolAgent } = await newTeam();
  const first = await call(bobAgent, "ask", { question: QUESTION, context: "Auth" });
  await call(carolAgent, "join_question", { question_id: first.question_id });
  await call(carolAgent, "join_question", { question_id: first.question_id });
  assert.equal((await waiterIds(first.question_id)).length, 2);
  const missing = await carolAgent.callTool({ name: "join_question", arguments: { question_id: randomUUID() } });
  assert.ok(missing.isError);
});

test("search_decisions finds active decisions only, and only from this team", async () => {
  const { teamId, bobAgent } = await newTeam();
  const other = await newTeam();
  const embedding = async (text: string) => {
    const { data, error } = await lead.supabase.functions.invoke("embed", { body: { text } });
    assert.ifError(error);
    return JSON.stringify(data.embedding);
  };
  const add = async (team: string, text: string, status = "active") => {
    const { error } = await lead.supabase
      .from("decisions")
      .insert({ team_id: team, decided_by: lead.userId, text, status, embedding: await embedding(text) });
    assert.ifError(error);
  };
  await add(teamId, "The session timeout is 37 minutes");
  await add(teamId, "The session timeout was 10 minutes", "superseded");
  await add(teamId, "The office dog is called Biscuit");
  await add(other.teamId, "The session timeout is 99 minutes");

  const { decisions } = await call(bobAgent, "search_decisions", { query: "How long is the session timeout?" });
  const texts = decisions.map((decision: { text: string }) => decision.text);
  assert.equal(texts[0], "The session timeout is 37 minutes");
  assert.ok(!texts.includes("The session timeout was 10 minutes"));
  assert.ok(!texts.includes("The session timeout is 99 minutes"));
  assert.ok(!texts.includes("The office dog is called Biscuit"));
});

test("questions route to the task owner, then the file owner, then the lead", async () => {
  const { bobAgent, carolAgent } = await newTeam();
  const routedTo = async (question: string, extra: Record<string, unknown>) => {
    const { question_id } = await call(carolAgent, "ask", { question, context: "x", confirmed_new: true, ...extra });
    const { data } = await admin.from("questions").select("routed_to").eq("id", question_id).single();
    return data!.routed_to;
  };
  const { task } = await call(bobAgent, "create_task", { title: "Checkout", files: ["src/checkout.ts"] });
  await call(bobAgent, "claim_task", { task_id: task.id });
  const { task: carolTask } = await call(carolAgent, "create_task", { title: "Mine", files: ["src/mine.ts"] });
  await call(carolAgent, "claim_task", { task_id: carolTask.id });
  const { task: unowned } = await call(bobAgent, "create_task", { title: "Unowned", files: ["src/free.ts"] });

  assert.equal(await routedTo("Task owner?", { task_id: task.id }), bob.userId);
  assert.equal(await routedTo("File owner?", { files: ["src/checkout.ts", "src/other.ts"] }), bob.userId);
  assert.equal(await routedTo("No details?", {}), lead.userId);
  assert.equal(await routedTo("My own task?", { task_id: carolTask.id }), lead.userId);
  assert.equal(await routedTo("My own files?", { files: ["src/mine.ts"] }), lead.userId);
  assert.equal(await routedTo("Nobody's task?", { task_id: unowned.id }), lead.userId);
  assert.equal(await routedTo("Untouched files?", { files: ["src/nothing.ts"] }), lead.userId);
});

test("an outsider calling the broker directly learns nothing and changes nothing", async () => {
  const { teamId, bobAgent } = await newTeam();
  await call(bobAgent, "ask", { question: QUESTION, context: "Auth" });
  const { data } = await outsider.supabase.functions.invoke("embed", { body: { text: QUESTION } });
  const embedding = JSON.stringify(data.embedding);

  const asked = await outsider.supabase.rpc("ask_question", {
    target_team: teamId,
    question_text: QUESTION,
    question_context: "x",
    question_embedding: embedding,
    target_routed_to: null,
    candidate_threshold: 0,
    confirmed_new: false,
  });
  assert.ok(asked.error, "the insert is refused, and no candidates are returned");
  assert.equal(asked.data, null);
  assert.equal(await questionCount(teamId), 1);

  const searched = await outsider.supabase.rpc("search_decisions", {
    target_team: teamId,
    query_embedding: embedding,
    minimum_similarity: 0,
    match_count: 5,
  });
  assert.deepEqual(searched.data, []);
});

test("secrets are removed before a question is embedded or stored", async () => {
  const { bobAgent } = await newTeam();
  const secret = "sb_secret_abcdefghijklmnop123456";
  const { question_id } = await call(bobAgent, "ask", { question: `Should ${secret} be rotated?`, context: `API_KEY=${secret}` });
  const { data } = await admin.from("questions").select("text, context, embedding").eq("id", question_id).single();
  assert.ok(!JSON.stringify(data).includes(secret));
  assert.ok(data!.embedding, "the question still gets an embedding");
});
