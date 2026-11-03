// Drives the sidebar controller against the linked Supabase project.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createClient } from "@supabase/supabase-js";
import { confirmationUrl, HackyApi } from "./api.js";
import { SidebarController, type SidebarState } from "./controller.js";

const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY } = process.env as Record<string, string>;
const admin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const tempDir = mkdtempSync(join(tmpdir(), "hacky-controller-"));
const userIds: string[] = [];
const teamIds = new Set<string>();
const disposers: (() => void | Promise<void>)[] = [];

function sidebar(label: string, workspace: string | null = null) {
  const api = new HackyApi(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, join(tempDir, `${label}.json`));
  const states: SidebarState[] = [];
  let savedTeam: string | undefined;
  const controller = new SidebarController({
    api,
    supabaseUrl: SUPABASE_URL,
    publishableKey: SUPABASE_PUBLISHABLE_KEY,
    workspaceDir: () => workspace,
    loadTeamId: () => savedTeam,
    saveTeamId: (teamId) => (savedTeam = teamId),
    post: (state) => states.push(state),
  });
  disposers.push(() => controller.dispose(), () => api.dispose());
  const last = () => states.at(-1)!;
  return { api, controller, states, last };
}

async function createConfirmedUser(label: string) {
  const email = `hacky-test-${label}-${randomBytes(6).toString("hex")}@example.com`;
  const password = randomBytes(24).toString("hex");
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(error);
  userIds.push(data.user!.id);
  return { email, password };
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

let workspace: string;
let alice: ReturnType<typeof sidebar>;
let bob: ReturnType<typeof sidebar>;

before(async () => {
  workspace = mkdtempSync(join(tmpdir(), "hacky-workspace-"));
  alice = sidebar("alice", workspace);
  bob = sidebar("bob");
  const aliceLogin = await createConfirmedUser("alice");
  const bobLogin = await createConfirmedUser("bob");
  await alice.controller.handle({ type: "ready" });
  assert.equal(alice.last().user, null, "starts signed out");
  await alice.controller.handle({ type: "signIn", ...aliceLogin });
  await bob.controller.handle({ type: "signIn", ...bobLogin });
});

after(async () => {
  for (const dispose of disposers) await dispose();
  for (const id of teamIds) await admin.from("teams").delete().eq("id", id);
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

test("a wrong password shows an error, and the password isn't in the state", async () => {
  const stranger = sidebar("stranger");
  await stranger.controller.handle({ type: "signIn", email: "nobody@example.com", password: "wrong-password-value" });
  assert.equal(stranger.last().user, null);
  assert.ok(stranger.last().error);
  assert.ok(!JSON.stringify(stranger.states).includes("wrong-password-value"));
});

test("login stores the session where the MCP server reads it", () => {
  const stored = JSON.parse(readFileSync(join(tempDir, "alice.json"), "utf8"));
  assert.ok(JSON.parse(Object.values(stored)[0] as string).refresh_token);
  assert.ok(alice.last().user);
});

test("creating a team opens it, and joining with the invite code shares it", async () => {
  await alice.controller.handle({ type: "createTeam", name: "Sidebar test", displayName: "Alice" });
  const team = alice.last().team!;
  assert.equal(team.name, "Sidebar test");
  assert.equal(team.role, "lead");
  teamIds.add(team.id);

  await bob.controller.handle({ type: "joinTeam", code: "wrong-code", displayName: "Bob" });
  assert.match(bob.last().error!, /invalid invite code/);
  assert.equal(bob.last().team, null);

  await bob.controller.handle({ type: "joinTeam", code: ` ${team.invite_code} `, displayName: "Bob" });
  assert.equal(bob.last().error, null);
  assert.equal(bob.last().team!.id, team.id);
  assert.equal(bob.last().team!.role, "member");
});

test("connecting writes the workspace files for this team", async () => {
  assert.equal(alice.last().workspace, "not_connected");
  await alice.controller.handle({ type: "connectWorkspace" });
  assert.equal(alice.last().error, null);
  assert.equal(alice.last().workspace, "connected");
  const mcp = JSON.parse(readFileSync(join(workspace, ".mcp.json"), "utf8"));
  assert.equal(mcp.mcpServers.hacky.env.HACKY_TEAM_ID, alice.last().team!.id);
  assert.ok(!readFileSync(join(workspace, ".mcp.json"), "utf8").includes(SUPABASE_SECRET_KEY));
});

test("connecting with no folder open explains the problem", async () => {
  await bob.controller.handle({ type: "connectWorkspace" });
  assert.match(bob.last().error!, /Open a folder/);
});

test("a question and a progress update appear live in a teammate's sidebar", async () => {
  const teamId = alice.last().team!.id;
  const bobAuth = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { storage: (await import("hacky-mcp-server/credentials")).fileStorage(join(tempDir, "bob.json")), persistSession: true, autoRefreshToken: false },
  });
  const { data } = await bobAuth.auth.getSession();
  const bobId = data.session!.user.id;

  // Give the Realtime channel time to join before the changes happen.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const posted = alice.states.length;

  const { data: question, error } = await bobAuth
    .from("questions")
    .insert({ team_id: teamId, text: "Which colour?", context: "Theme work", asked_by: bobId, routed_to: alice.last().team ? (await admin.from("members").select("user_id").eq("team_id", teamId).eq("role", "lead").single()).data!.user_id : null })
    .select("id")
    .single();
  assert.ifError(error);
  // A wait belongs to a chat, so Bob needs a session first.
  const sessionId = randomUUID();
  assert.ifError((await bobAuth.rpc("start_session", { target_team: teamId, new_session: sessionId })).error);
  assert.ifError((await bobAuth.from("question_waiters").insert({ team_id: teamId, question_id: question!.id, user_id: bobId, session_id: sessionId })).error);
  await bobAuth.from("events").insert({ team_id: teamId, user_id: bobId, summary: "Picked up theming" });

  // Well under the 30 second fallback timer, so this can only be Realtime.
  await waitFor(() => alice.states.slice(posted).some((state) => state.inbox.length === 1 && state.feed.length === 1), "live update", 15_000);
  const inboxItem = alice.last().inbox[0];
  assert.equal(inboxItem.text, "Which colour?");
  assert.equal(inboxItem.asked_by_name, "Bob");
  assert.equal(inboxItem.routed_to_me, true);
  assert.equal(inboxItem.waiting, 1);
  assert.equal(alice.last().feed[0].author, "Bob");

  // Bob isn't the lead, so it isn't marked for him.
  await bob.controller.refresh();
  assert.equal(bob.last().inbox[0].routed_to_me, false);
});

test("answering saves a decision, closes the question, and filters secrets", async () => {
  const question = alice.last().inbox[0];
  await alice.controller.handle({ type: "answer", questionId: question.id, text: "Blue. API_KEY=sb_secret_abcdefghijklmnop123456" });
  assert.equal(alice.last().error, null);
  assert.equal(alice.last().inbox.length, 0);
  const { data } = await admin.from("questions").select("status, decisions(text, status)").eq("id", question.id).single();
  assert.equal(data!.status, "answered");
  assert.equal((data!.decisions as any).text, "Blue. API_KEY=[REDACTED]");
  const { data: decision } = await admin
    .from("decisions")
    .select("embedding")
    .eq("team_id", alice.last().team!.id)
    .single();
  assert.ok(decision!.embedding, "the answer is searchable");
});

test("a second answer to the same question is refused", async () => {
  const { data: questions } = await admin.from("questions").select("id").eq("team_id", alice.last().team!.id);
  await bob.controller.handle({ type: "answer", questionId: questions![0].id, text: "Red" });
  assert.match(bob.last().error!, /no longer open/);
  const { count } = await admin.from("decisions").select("*", { count: "exact", head: true }).eq("team_id", alice.last().team!.id);
  assert.equal(count, 1);
});

test("someone outside the team can't answer its questions or see them", async () => {
  const teamId = alice.last().team!.id;
  const { data: asker } = await admin.from("members").select("user_id").eq("team_id", teamId).limit(1).single();
  const { data: question } = await admin
    .from("questions")
    .insert({ team_id: teamId, text: "Private?", asked_by: asker!.user_id })
    .select("id")
    .single();
  const outsider = sidebar("outsider");
  await outsider.controller.handle({ type: "signIn", ...(await createConfirmedUser("outsider")) });
  await outsider.controller.handle({ type: "answer", questionId: question!.id, text: "Mine" });
  assert.ok(outsider.last().error);
  const { data: stored } = await admin.from("questions").select("status").eq("id", question!.id).single();
  assert.equal(stored!.status, "open");
  assert.deepEqual(await outsider.api.inbox(teamId), []);
});

async function questionWithAssumption(teamId: string, text: string, assumption: string) {
  const { data: asker } = await admin.from("members").select("user_id").eq("team_id", teamId).eq("role", "member").single();
  const { data: question } = await admin
    .from("questions")
    .insert({ team_id: teamId, text, asked_by: asker!.user_id })
    .select("id")
    .single();
  // A wait belongs to a chat, so the asker needs a session first.
  const sessionId = randomUUID();
  assert.ifError((await admin.from("agent_sessions").insert({ id: sessionId, team_id: teamId, user_id: asker!.user_id })).error);
  assert.ifError((await admin.from("question_waiters").insert({ team_id: teamId, question_id: question!.id, user_id: asker!.user_id, session_id: sessionId })).error);
  assert.ifError((await admin.from("assumptions").insert({ team_id: teamId, question_id: question!.id, user_id: asker!.user_id, text: assumption })).error);
  return { questionId: question!.id as string, userId: asker!.user_id as string };
}

test("rejecting an assumption removes it from the panel, tells the agent, and filters secrets", async () => {
  const teamId = alice.last().team!.id;
  const { questionId, userId } = await questionWithAssumption(teamId, "Which plan?", "Pro plan");
  await alice.controller.refresh();
  const assumption = alice.last().assumptions.find((item) => item.text === "Pro plan")!;
  assert.equal(assumption.question, "Which plan?");
  assert.equal(assumption.author, "Bob");

  await alice.controller.handle({
    type: "rejectAssumption",
    assumptionId: assumption.id,
    reason: "Free plan. API_KEY=sb_secret_abcdefghijklmnop123456",
  });
  assert.equal(alice.last().error, null);
  assert.ok(!alice.last().assumptions.some((item) => item.id === assumption.id));
  assert.ok(alice.last().inbox.some((item) => item.id === questionId), "the question is still open");
  const { data: notices } = await admin.from("notices").select("kind, text").eq("question_id", questionId).eq("user_id", userId);
  assert.deepEqual(notices, [{ kind: "assumption_rejected", text: "Free plan. API_KEY=[REDACTED]" }]);
});

test("confirming an assumption turns it into a searchable decision", async () => {
  const teamId = alice.last().team!.id;
  const { questionId } = await questionWithAssumption(teamId, "Which region?", "EU only");
  await alice.controller.refresh();
  const assumption = alice.last().assumptions.find((item) => item.text === "EU only")!;
  await alice.controller.handle({ type: "confirmAssumption", assumptionId: assumption.id });
  assert.equal(alice.last().error, null);
  assert.ok(!alice.last().inbox.some((item) => item.id === questionId));
  assert.ok(!alice.last().assumptions.some((item) => item.id === assumption.id));
  const decision = alice.last().decisions.find((item) => item.text === "EU only")!;
  assert.equal(decision.question, "Which region?");
  assert.equal(decision.author, "Alice");
  const { data } = await admin.from("decisions").select("embedding").eq("id", decision.id).single();
  assert.ok(data!.embedding);
});

test("an assumption on an answered question leaves the panel", async () => {
  const teamId = alice.last().team!.id;
  const { questionId } = await questionWithAssumption(teamId, "Which font?", "Inter");
  await alice.controller.handle({ type: "answer", questionId, text: "Roboto" });
  assert.ok(!alice.last().assumptions.some((item) => item.text === "Inter"));
});

test("changing and withdrawing a decision update the list and notify the team", async () => {
  const teamId = alice.last().team!.id;
  const { questionId } = await questionWithAssumption(teamId, "Which colour scheme?", "Dark");
  await alice.controller.handle({ type: "answer", questionId, text: "Light" });
  const first = alice.last().decisions.find((item) => item.text === "Light")!;

  await alice.controller.handle({ type: "changeDecision", decisionId: first.id, text: "Sepia. API_KEY=sb_secret_abcdefghijklmnop123456" });
  assert.equal(alice.last().error, null);
  const second = alice.last().decisions.find((item) => item.text === "Sepia. API_KEY=[REDACTED]")!;
  assert.ok(!alice.last().decisions.some((item) => item.id === first.id));
  const { data: embedded } = await admin.from("decisions").select("embedding").eq("id", second.id).single();
  assert.ok(embedded!.embedding, "the replacement is searchable");

  await alice.controller.handle({ type: "withdrawDecision", decisionId: second.id });
  assert.equal(alice.last().error, null);
  assert.ok(!alice.last().decisions.some((item) => item.id === second.id));
  assert.ok(alice.last().inbox.some((item) => item.id === questionId), "the question is back in the inbox");

  const { data: notices } = await admin.from("notices").select("kind").eq("question_id", questionId);
  const kinds = notices!.map((notice) => notice.kind);
  assert.equal(kinds.filter((kind) => kind === "decision_changed").length, 2, "both members");
  assert.equal(kinds.filter((kind) => kind === "decision_withdrawn").length, 2, "both members");
});

test("the task board shows owners and status, and a task can be added", async () => {
  const teamId = alice.last().team!.id;
  await alice.controller.handle({ type: "addTask", title: "Write docs. API_KEY=sb_secret_abcdefghijklmnop123456" });
  assert.equal(alice.last().error, null);
  const added = alice.last().tasks.find((task) => task.title.startsWith("Write docs"))!;
  assert.equal(added.title, "Write docs. API_KEY=[REDACTED]");
  assert.equal(added.status, "todo");
  assert.equal(added.owner, null);

  const { data: member } = await admin.from("members").select("user_id").eq("team_id", teamId).eq("role", "member").single();
  await admin.from("tasks").update({ owner_id: member!.user_id, status: "in_progress", files: ["docs.md"] }).eq("id", added.id);
  await alice.controller.refresh();
  const claimed = alice.last().tasks.find((task) => task.id === added.id)!;
  assert.equal(claimed.owner, "Bob");
  assert.equal(claimed.status, "in_progress");
  assert.deepEqual(claimed.files, ["docs.md"]);
});

test("the confirmation link goes back to the editor, for each editor the project allows", async () => {
  for (const scheme of ["vscode", "vscode-insiders"]) {
    const email = `hacky-test-link-${randomBytes(6).toString("hex")}@example.com`;
    const { data, error } = await admin.auth.admin.generateLink({
      type: "signup",
      email,
      password: randomBytes(24).toString("hex"),
      options: { redirectTo: confirmationUrl(scheme) },
    });
    assert.ifError(error);
    userIds.push(data.user!.id);
    const response = await fetch(data.properties!.action_link, { redirect: "manual" });
    const location = response.headers.get("location") ?? "";
    assert.ok(location.startsWith(`${scheme}://hacky.hacky/confirmed`), `redirected to ${location.split("#")[0]}`);
  }
});

test("logging out returns to the login screen", async () => {
  const leaver = sidebar("leaver");
  await leaver.controller.handle({ type: "signIn", ...(await createConfirmedUser("leaver")) });
  assert.ok(leaver.last().user);
  await leaver.controller.handle({ type: "signOut" });
  assert.equal(leaver.last().user, null);
});
