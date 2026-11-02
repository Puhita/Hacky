// Proves team isolation against the linked project, using real signed-in clients.
// Run with: node --env-file=.env --test supabase/tests/isolation.test.mjs
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { createClient } from "@supabase/supabase-js";

const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY } = process.env;
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, options);

const createdUsers = [];
const createdTeams = [];

async function signedInClient(label) {
  const email = `hacky-test-${label}-${randomBytes(6).toString("hex")}@example.com`;
  const password = randomBytes(24).toString("hex");
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(error);
  createdUsers.push(data.user.id);
  const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, options);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signInError);
  return { client, userId: data.user.id };
}

async function createTeam(client, name) {
  const { data, error } = await client.rpc("create_team", { team_name: name, member_name: "Lead" });
  assert.ifError(error);
  createdTeams.push(data.id);
  return data;
}

// Every shared table, with a row that member `userId` of `teamId` is allowed to insert.
const ROWS = {
  tasks: (teamId) => ({ team_id: teamId, title: "task" }),
  events: (teamId, userId) => ({ team_id: teamId, user_id: userId, summary: "event" }),
  decisions: (teamId, userId) => ({ team_id: teamId, decided_by: userId, text: "decision" }),
  questions: (teamId, userId) => ({ team_id: teamId, asked_by: userId, text: "question" }),
  assumptions: (teamId, userId) => ({ team_id: teamId, user_id: userId, text: "assumption" }),
  agent_sessions: (teamId, userId) => ({ team_id: teamId, user_id: userId, focus: "session" }),
};

let alice, bob, teamA, teamB;
const aliceRows = {};

before(async () => {
  alice = await signedInClient("alice");
  bob = await signedInClient("bob");
  teamA = await createTeam(alice.client, "Team A");
  teamB = await createTeam(bob.client, "Team B");
  for (const [table, row] of Object.entries(ROWS)) {
    const { data, error } = await alice.client.from(table).insert(row(teamA.id, alice.userId)).select().single();
    assert.ifError(error);
    aliceRows[table] = data;
  }
  const { error } = await alice.client
    .from("question_waiters")
    .insert({
      team_id: teamA.id,
      question_id: aliceRows.questions.id,
      user_id: alice.userId,
      session_id: aliceRows.agent_sessions.id,
    });
  assert.ifError(error);
});

after(async () => {
  for (const id of createdTeams) await admin.from("teams").delete().eq("id", id);
  for (const id of createdUsers) await admin.auth.admin.deleteUser(id);
});

test("members can read their own team's rows", async () => {
  for (const table of [...Object.keys(ROWS), "question_waiters"]) {
    const { data, error } = await alice.client.from(table).select().eq("team_id", teamA.id);
    assert.ifError(error);
    assert.equal(data.length, 1, table);
  }
});

test("a member of another team reads nothing", async () => {
  for (const table of [...Object.keys(ROWS), "question_waiters", "members"]) {
    const { data, error } = await bob.client.from(table).select().eq("team_id", teamA.id);
    assert.ifError(error);
    assert.deepEqual(data, [], table);
  }
  const { data, error } = await bob.client.from("teams").select().eq("id", teamA.id);
  assert.ifError(error);
  assert.deepEqual(data, []);
});

test("a member of another team can't insert into the team", async () => {
  for (const [table, row] of Object.entries(ROWS)) {
    const { error } = await bob.client.from(table).insert(row(teamA.id, bob.userId));
    assert.ok(error, `${table} insert should be rejected`);
  }
});

test("a member of another team can't update rows", async () => {
  const fields = {
    tasks: { title: "x" },
    decisions: { text: "x" },
    questions: { text: "x" },
    assumptions: { text: "x" },
    agent_sessions: { focus: "x" },
  };
  for (const [table, change] of Object.entries(fields)) {
    await bob.client.from(table).update(change).eq("id", aliceRows[table].id);
    const { data } = await admin.from(table).select().eq("id", aliceRows[table].id).single();
    assert.deepEqual(data, aliceRows[table], table);
  }
});

test("a member can't move a row into another team", async () => {
  const { error } = await alice.client.from("tasks").update({ team_id: teamB.id }).eq("id", aliceRows.tasks.id);
  assert.ok(error);
});

test("a member can't write as a teammate", async () => {
  const { data: joined, error: joinError } = await bob.client.rpc("join_team", { code: teamA.invite_code, member_name: "Bob" });
  assert.ifError(joinError);
  assert.equal(joined, teamA.id);
  const { error } = await bob.client.from("events").insert({ team_id: teamA.id, user_id: alice.userId, summary: "forged" });
  assert.ok(error);
  await admin.from("members").delete().eq("team_id", teamA.id).eq("user_id", bob.userId);
});

test("a wait or a question can't be attached to a teammate's session", async () => {
  const { data: joined, error: joinError } = await bob.client.rpc("join_team", { code: teamA.invite_code, member_name: "Bob" });
  assert.ifError(joinError);
  assert.equal(joined, teamA.id);
  const { error } = await bob.client
    .from("question_waiters")
    .insert({ team_id: teamA.id, question_id: aliceRows.questions.id, user_id: bob.userId, session_id: aliceRows.agent_sessions.id });
  assert.ok(error, "bob can't wait as alice's chat");
  const { error: peerError } = await bob.client.from("peer_questions").insert({
    team_id: teamA.id,
    from_user: bob.userId,
    from_session: aliceRows.agent_sessions.id,
    to_user: alice.userId,
    question: "spoofed",
  });
  assert.ok(peerError, "bob can't ask from alice's chat");
  await admin.from("members").delete().eq("team_id", teamA.id).eq("user_id", bob.userId);
});

test("agent questions are private to the two people involved, and only the recipient answers", async () => {
  const carol = await signedInClient("carol");
  for (const [who, name] of [[bob, "Bob"], [carol, "Carol"]]) {
    const { error } = await who.client.rpc("join_team", { code: teamA.invite_code, member_name: name });
    assert.ifError(error);
  }
  const { data: asked, error } = await alice.client
    .from("peer_questions")
    .insert({
      team_id: teamA.id,
      from_user: alice.userId,
      from_session: aliceRows.agent_sessions.id,
      to_user: carol.userId,
      question: "private?",
    })
    .select("id")
    .single();
  assert.ifError(error);

  assert.deepEqual((await bob.client.from("peer_questions").select("id").eq("team_id", teamA.id)).data, [], "a bystander on the team sees nothing");
  assert.ok((await bob.client.rpc("answer_peer_question", { target_question: asked.id, answer_text: "x", answering_session: null })).error);
  assert.ok((await alice.client.rpc("answer_peer_question", { target_question: asked.id, answer_text: "x", answering_session: null })).error, "the asker can't answer");
  assert.equal((await carol.client.from("peer_questions").select("id").eq("team_id", teamA.id)).data.length, 1);
  assert.ifError((await carol.client.rpc("answer_peer_question", { target_question: asked.id, answer_text: "yes", answering_session: null })).error);
  assert.equal((await alice.client.from("peer_questions").select("answer").eq("id", asked.id).single()).data.answer, "yes");

  await admin.from("members").delete().eq("team_id", teamA.id).in("user_id", [bob.userId, carol.userId]);
});

test("a row can't reference another team's member", async () => {
  const { error } = await alice.client.from("tasks").insert({ team_id: teamA.id, title: "x", owner_id: bob.userId });
  assert.ok(error);
});

test("joining requires a valid invite code", async () => {
  const { error } = await bob.client.rpc("join_team", { code: "not-a-real-code", member_name: "Bob" });
  assert.ok(error);
  const { error: directError } = await bob.client
    .from("members")
    .insert({ team_id: teamA.id, user_id: bob.userId, display_name: "Bob" });
  assert.ok(directError);
});

test("a member can't change their own role or team name directly", async () => {
  await alice.client.from("members").update({ role: "member" }).eq("user_id", alice.userId);
  const { data } = await admin.from("members").select("role").eq("team_id", teamA.id).eq("user_id", alice.userId).single();
  assert.equal(data.role, "lead");
  await alice.client.from("teams").update({ name: "renamed" }).eq("id", teamA.id);
  const { data: team } = await admin.from("teams").select("name").eq("id", teamA.id).single();
  assert.equal(team.name, "Team A");
});

test("signed-out clients can't read or call anything", async () => {
  const anon = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, options);
  for (const table of ["teams", "members", ...Object.keys(ROWS), "question_waiters", "peer_questions", "notice_deliveries"]) {
    const { data, error } = await anon.from(table).select().limit(1);
    assert.ok(error || data.length === 0, table);
  }
  const { error } = await anon.rpc("create_team", { team_name: "x", member_name: "x" });
  assert.ok(error);
});
