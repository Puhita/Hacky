// Runs the built server over stdio with a real MCP client, against the linked Supabase project.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const adminOptions = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, adminOptions);

const tempDir = mkdtempSync(join(tmpdir(), "hacky-mcp-test-"));
const userIds: string[] = [];
const teamIds: string[] = [];
const clients: Client[] = [];

type User = { supabase: SupabaseClient; userId: string; credentials: string };

async function createUser(label: string): Promise<User> {
  const email = `hacky-test-${label}-${randomBytes(6).toString("hex")}@example.com`;
  const password = randomBytes(24).toString("hex");
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(error);
  userIds.push(data.user!.id);
  const credentials = join(tempDir, `${label}.json`);
  const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { storage: fileStorage(credentials), persistSession: true, autoRefreshToken: false },
  });
  const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
  assert.ifError(signInError);
  return { supabase, userId: data.user!.id, credentials };
}

async function connect(credentials: string, teamId: string): Promise<Client> {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: {
        HACKY_SUPABASE_URL: SUPABASE_URL,
        HACKY_SUPABASE_PUBLISHABLE_KEY: SUPABASE_PUBLISHABLE_KEY,
        HACKY_TEAM_ID: teamId,
        HACKY_CREDENTIALS_FILE: credentials,
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

async function callExpectingError(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(result.isError, `${name} should have failed`);
  return (result.content as { text: string }[])[0].text;
}

let alice: User, bob: User, outsider: User;
let teamId: string;
let aliceAgent: Client, bobAgent: Client;

before(async () => {
  alice = await createUser("alice");
  bob = await createUser("bob");
  outsider = await createUser("outsider");
  const { data: team, error } = await alice.supabase.rpc("create_team", { team_name: "MCP test", member_name: "Alice" });
  assert.ifError(error);
  teamId = team.id;
  teamIds.push(teamId);
  const { error: joinError } = await bob.supabase.rpc("join_team", { code: team.invite_code, member_name: "Bob" });
  assert.ifError(joinError);
  aliceAgent = await connect(alice.credentials, teamId);
  bobAgent = await connect(bob.credentials, teamId);
});

after(async () => {
  for (const client of clients) await client.close();
  for (const id of teamIds) await admin.from("teams").delete().eq("id", id);
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
  rmSync(tempDir, { recursive: true, force: true });
});

async function seedTask(title: string): Promise<string> {
  const { data, error } = await alice.supabase.from("tasks").insert({ team_id: teamId, title }).select("id").single();
  assert.ifError(error);
  return data!.id;
}

test("log_progress reaches a teammate's get_context, not your own feed", async () => {
  await call(aliceAgent, "log_progress", { summary: "Added the cart page", files: ["src/cart.ts"] });
  const bobView = await call(bobAgent, "get_context");
  assert.equal(bobView.recent_activity[0].summary, "Added the cart page");
  assert.deepEqual(bobView.recent_activity[0].files, ["src/cart.ts"]);
  assert.equal(bobView.recent_activity[0].members.display_name, "Alice");
  const aliceView = await call(aliceAgent, "get_context");
  assert.ok(!aliceView.recent_activity.some((event: { summary: string }) => event.summary === "Added the cart page"));
});

test("get_context splits my tasks from unclaimed tasks", async () => {
  const taskId = await seedTask("Build the checkout");
  assert.ok((await call(bobAgent, "get_context")).unclaimed_tasks.some((task: { id: string }) => task.id === taskId));
  await call(bobAgent, "claim_task", { task_id: taskId });
  const view = await call(bobAgent, "get_context");
  assert.ok(view.my_tasks.some((task: { id: string }) => task.id === taskId));
  assert.ok(!view.unclaimed_tasks.some((task: { id: string }) => task.id === taskId));
});

test("when two agents race for a task, exactly one wins", async () => {
  const taskId = await seedTask("Contested task");
  const results = await Promise.all([
    call(aliceAgent, "claim_task", { task_id: taskId }),
    call(bobAgent, "claim_task", { task_id: taskId }),
  ]);
  assert.equal(results.filter((result) => result.claimed).length, 1);
  const loser = results.find((result) => !result.claimed);
  assert.ok(["Alice", "Bob"].includes(loser.owned_by));
});

test("claiming your own task again is fine, and unknown tasks are an error", async () => {
  const taskId = await seedTask("Mine");
  await call(bobAgent, "claim_task", { task_id: taskId });
  const again = await call(bobAgent, "claim_task", { task_id: taskId });
  assert.equal(again.already_yours, true);
  assert.match(await callExpectingError(bobAgent, "claim_task", { task_id: randomUUID() }), /No task/);
});

test("a task created by one agent can be claimed and completed by a teammate's", async () => {
  const { task } = await call(aliceAgent, "create_task", { title: "Ship the docs", files: ["docs/README.md"] });
  assert.ok((await call(bobAgent, "get_context")).unclaimed_tasks.some((item: { id: string }) => item.id === task.id));

  const notClaimed = await call(bobAgent, "complete_task", { task_id: task.id });
  assert.equal(notClaimed.completed, false);
  assert.match(notClaimed.reason, /claim_task/);

  await call(bobAgent, "claim_task", { task_id: task.id });
  const notYours = await call(aliceAgent, "complete_task", { task_id: task.id });
  assert.equal(notYours.completed, false);
  assert.match(notYours.reason, /Bob/);

  assert.equal((await call(bobAgent, "complete_task", { task_id: task.id })).completed, true);
  const view = await call(bobAgent, "get_context");
  assert.ok(!view.my_tasks.some((item: { id: string }) => item.id === task.id));
  assert.match(await callExpectingError(bobAgent, "complete_task", { task_id: randomUUID() }), /No task/);
});

test("create_task removes secrets from the title", async () => {
  const secret = "sb_secret_abcdefghijklmnop123456";
  const { task } = await call(aliceAgent, "create_task", { title: `Rotate ${secret}` });
  const { data } = await admin.from("tasks").select("title").eq("id", task.id).single();
  assert.equal(data!.title, "Rotate [REDACTED]");
});

test("a held check_answers returns the answer as soon as a teammate gives it, exactly once", async () => {
  const { question_id } = await call(bobAgent, "ask", { question: "What discount?", context: "Pricing", assumption: "10%", confirmed_new: true });
  assert.deepEqual((await call(bobAgent, "check_answers")).still_pending, [question_id]);

  const { data: question } = await admin.from("questions").select("routed_to").eq("id", question_id).single();
  assert.equal(question!.routed_to, alice.userId);
  const { data: assumptions } = await admin.from("assumptions").select("text, status").eq("question_id", question_id);
  assert.deepEqual(assumptions, [{ text: "10%", status: "pending" }]);

  const startedAt = Date.now();
  const waiting = call(bobAgent, "check_answers", { wait_seconds: 60 });
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const { data: decision, error } = await alice.supabase
    .from("decisions")
    .insert({ team_id: teamId, decided_by: alice.userId, text: "17% off" })
    .select("id")
    .single();
  assert.ifError(error);
  const { error: updateError } = await alice.supabase
    .from("questions")
    .update({ status: "answered", decision_id: decision!.id })
    .eq("id", question_id);
  assert.ifError(updateError);

  const { answers, still_pending } = await waiting;
  assert.deepEqual(answers, [{ question_id, question: "What discount?", answer: "17% off", your_assumption: "10%" }]);
  assert.deepEqual(still_pending, []);
  assert.ok(Date.now() - startedAt >= 5000 && Date.now() - startedAt < 30_000);
  assert.deepEqual((await call(bobAgent, "check_answers")).answers, []);
  assert.ok((await call(bobAgent, "get_context")).active_decisions.some((item: { text: string }) => item.text === "17% off"));
});

test("a held check_answers gives up when wait_seconds runs out", async () => {
  const { question_id } = await call(aliceAgent, "ask", { question: "Unanswered?", context: "Test", confirmed_new: true });
  const startedAt = Date.now();
  const result = await call(aliceAgent, "check_answers", { wait_seconds: 4 });
  assert.deepEqual(result, { answers: [], notices: [], still_pending: [question_id] });
  assert.ok(Date.now() - startedAt >= 4000);
});

test("an answer given while no session is running goes to the next chat once it takes over", async () => {
  const { question_id } = await call(bobAgent, "ask", { question: "Late one?", context: "Test", confirmed_new: true });
  const { data: decision } = await admin
    .from("decisions")
    .insert({ team_id: teamId, decided_by: alice.userId, text: "Late answer" })
    .select("id")
    .single();
  await admin.from("questions").update({ status: "answered", decision_id: decision!.id }).eq("id", question_id);

  // The wait belongs to the chat that asked, so the next chat is offered that chat instead.
  const nextSession = await connect(bob.credentials, teamId);
  const view = await call(nextSession, "get_context");
  assert.ok(!view.waiting_on.some((item: { question_id: string }) => item.question_id === question_id));
  const earlier = view.my_other_chats.find((chat: { waiting_on: string[] }) => chat.waiting_on.includes("Late one?"));
  assert.ok(earlier, "the chat that asked is listed with its open wait");

  // That chat is still running, so the person has to confirm it has stopped.
  const resumed = await call(nextSession, "resume_session", { session_id: earlier.session_id, takeover: true });
  assert.equal(resumed.resumed, true);
  assert.equal((await call(nextSession, "check_answers")).answers[0].answer, "Late answer");
});

test("secrets are removed before anything reaches the database", async () => {
  const secret = "sb_secret_abcdefghijklmnop123456";
  const { event_id } = await call(aliceAgent, "log_progress", { summary: `Rotated ${secret}`, files: [`API_KEY=${secret}`] });
  const { question_id } = await call(aliceAgent, "ask", {
    question: `Is ${secret} ok?`,
    context: `SUPABASE_SECRET_KEY=${secret}`,
    assumption: `Using ${secret}`,
    confirmed_new: true,
  });
  const stored = await Promise.all([
    admin.from("events").select("*").eq("id", event_id).single(),
    admin.from("questions").select("*").eq("id", question_id).single(),
    admin.from("assumptions").select("*").eq("question_id", question_id).single(),
  ]);
  for (const { data, error } of stored) {
    assert.ifError(error);
    assert.ok(!JSON.stringify(data).includes(secret), JSON.stringify(data));
  }
});

test("a user outside the team is refused by every tool", async () => {
  const agent = await connect(outsider.credentials, teamId);
  const tools: [string, Record<string, unknown>][] = [
    ["get_context", {}],
    ["log_progress", { summary: "x" }],
    ["claim_task", { task_id: randomUUID() }],
    ["create_task", { title: "x" }],
    ["complete_task", { task_id: randomUUID() }],
    ["ask", { question: "x", context: "x" }],
    ["search_decisions", { query: "x" }],
    ["join_question", { question_id: randomUUID() }],
    ["check_answers", {}],
  ];
  for (const [name, args] of tools) assert.match(await callExpectingError(agent, name, args), /not a member/);
});

test("a missing login gets a clear message", async () => {
  const agent = await connect(join(tempDir, "nobody.json"), teamId);
  assert.match(await callExpectingError(agent, "get_context"), /Not logged in/);
});

test("two servers sharing one login both survive an expired session", async () => {
  const user = await createUser("carol");
  const { data: team } = await user.supabase.rpc("create_team", { team_name: "Refresh test", member_name: "Carol" });
  teamIds.push(team.id);

  const stored = JSON.parse(readFileSync(user.credentials, "utf8"));
  const [key] = Object.keys(stored);
  const session = JSON.parse(stored[key]);
  const originalRefreshToken = session.refresh_token;
  session.expires_at = Math.floor(Date.now() / 1000) - 60;
  writeFileSync(user.credentials, JSON.stringify({ [key]: JSON.stringify(session) }));

  const [first, second] = await Promise.all([connect(user.credentials, team.id), connect(user.credentials, team.id)]);
  await Promise.all([call(first, "get_context"), call(second, "get_context")]);

  const rotated = JSON.parse(JSON.parse(readFileSync(user.credentials, "utf8"))[key]);
  assert.notEqual(rotated.refresh_token, originalRefreshToken);
  await call(first, "log_progress", { summary: "Still logged in" });
  await call(second, "log_progress", { summary: "Me too" });
});
