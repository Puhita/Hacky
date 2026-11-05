// Group management, roles and the profile, driven through the sidebar controller against the
// linked Supabase project. Needs supabase/migrations/20261105100000_group_management.sql applied.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createClient } from "@supabase/supabase-js";
import { HackyApi } from "./api.js";
import { checkNewPassword, SidebarController, type SidebarState } from "./controller.js";

const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY } = process.env as Record<string, string>;
const admin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const tempDir = mkdtempSync(join(tmpdir(), "hacky-groups-"));
const userIds: string[] = [];
const teamIds = new Set<string>();
const disposers: (() => void | Promise<void>)[] = [];

function sidebar(label: string) {
  const api = new HackyApi(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, join(tempDir, `${label}.json`));
  const states: SidebarState[] = [];
  let savedTeam: string | undefined;
  const controller = new SidebarController({
    api,
    supabaseUrl: SUPABASE_URL,
    publishableKey: SUPABASE_PUBLISHABLE_KEY,
    workspaceDir: () => null,
    loadTeamId: () => savedTeam,
    saveTeamId: (teamId) => (savedTeam = teamId),
    post: (state) => states.push(state),
  });
  disposers.push(() => controller.dispose(), () => api.dispose());
  return { controller, last: () => states.at(-1)! };
}

async function createUser(label: string) {
  const email = `hacky-test-${label}-${randomBytes(6).toString("hex")}@example.com`;
  const password = randomBytes(24).toString("hex");
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(error);
  userIds.push(data.user!.id);
  return { id: data.user!.id, email, password };
}

type Sidebar = ReturnType<typeof sidebar>;
const memberOf = (who: Sidebar, name: string) => who.last().members.find((member) => member.name === name)!;

let lead: Sidebar;
let ann: Sidebar;
let ben: Sidebar;
let leadUser: Awaited<ReturnType<typeof createUser>>;
let benUser: Awaited<ReturnType<typeof createUser>>;
let teamId: string;
let inviteCode: string;

before(async () => {
  leadUser = await createUser("lead");
  const annUser = await createUser("ann");
  benUser = await createUser("ben");
  lead = sidebar("lead");
  ann = sidebar("ann");
  ben = sidebar("ben");
  await lead.controller.handle({ type: "signIn", email: leadUser.email, password: leadUser.password });
  await ann.controller.handle({ type: "signIn", email: annUser.email, password: annUser.password });
  await ben.controller.handle({ type: "signIn", email: benUser.email, password: benUser.password });
  await lead.controller.handle({ type: "createTeam", name: "Groups test", displayName: "Lena" });
  teamId = lead.last().team!.id;
  teamIds.add(teamId);
  inviteCode = lead.last().team!.invite_code;
  await ann.controller.handle({ type: "joinTeam", code: inviteCode, displayName: "Ann" });
  await ben.controller.handle({ type: "joinTeam", code: inviteCode, displayName: "Ben" });
  await lead.controller.refresh();
});

after(async () => {
  for (const dispose of disposers) await dispose();
  for (const id of teamIds) await admin.from("teams").delete().eq("id", id);
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
  rmSync(tempDir, { recursive: true, force: true });
});

test("the password has to be repeated, and be long enough", () => {
  assert.throws(() => checkNewPassword("secret1", "secret2"), /don't match/);
  assert.throws(() => checkNewPassword("abc", "abc"), /at least 6/);
  checkNewPassword("secret1", "secret1");
});

test("signing up with two different passwords is refused before anything is sent", async () => {
  const stranger = sidebar("stranger");
  const email = `hacky-test-signup-${randomBytes(6).toString("hex")}@example.com`;
  await stranger.controller.handle({ type: "signUp", email, password: "secret-one", confirmPassword: "secret-two" });
  assert.match(stranger.last().error!, /don't match/);
  assert.equal(stranger.last().user, null);
  // No account was made, so the email is still free.
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  assert.ok(!data.users.some((user) => user.email === email));
});

test("a person in no group can still set their name on the profile", async () => {
  const user = await createUser("named");
  const named = sidebar("named");
  await named.controller.handle({ type: "signIn", email: user.email, password: user.password });
  assert.equal(named.last().user!.displayName, null);
  await named.controller.handle({ type: "updateProfile", displayName: "Nova" });
  assert.equal(named.last().error, null);
  assert.equal(named.last().user!.displayName, "Nova");
});

test("the groups page lists every group with its size and the person's role", async () => {
  assert.equal(lead.last().teams.length, 1);
  assert.equal(lead.last().teams[0].members, 3);
  assert.equal(lead.last().teams[0].role, "lead");
  assert.equal(ben.last().teams[0].role, "member");
  assert.deepEqual(
    lead.last().members.map((member) => [member.name, member.role, member.me]),
    [["Lena", "lead", true], ["Ann", "member", false], ["Ben", "member", false]],
  );
});

test("members cannot manage the group, and nothing changes", async () => {
  const annId = memberOf(lead, "Ann").id;
  const attempts = [
    { type: "renameTeam", name: "Hijacked" },
    { type: "regenerateInvite" },
    { type: "removeMember", userId: memberOf(lead, "Lena").id },
    { type: "setRole", userId: annId, role: "lead" },
    { type: "deleteTeam" },
  ] as const;
  for (const attempt of attempts) {
    await ann.controller.handle(attempt);
    assert.match(ann.last().error!, /only a group lead/, attempt.type);
  }
  await lead.controller.refresh();
  assert.equal(lead.last().team!.name, "Groups test");
  assert.equal(lead.last().team!.invite_code, inviteCode);
  assert.equal(lead.last().members.length, 3);
  assert.equal(memberOf(lead, "Ann").role, "member");
});

test("a lead renames the group, and everyone sees it", async () => {
  await lead.controller.handle({ type: "renameTeam", name: "  Renamed group  " });
  assert.equal(lead.last().error, null);
  assert.equal(lead.last().team!.name, "Renamed group");
  await ben.controller.refresh();
  assert.equal(ben.last().team!.name, "Renamed group");
  await lead.controller.handle({ type: "renameTeam", name: "   " });
  assert.match(lead.last().error!, /needs a name/);
});

test("a new invite code replaces the old one", async () => {
  await lead.controller.handle({ type: "regenerateInvite" });
  const fresh = lead.last().team!.invite_code;
  assert.notEqual(fresh, inviteCode);
  const late = await createUser("late");
  const outsider = sidebar("outsider");
  await outsider.controller.handle({ type: "signIn", email: late.email, password: late.password });
  await outsider.controller.handle({ type: "joinTeam", code: inviteCode, displayName: "Late" });
  assert.match(outsider.last().error!, /invalid invite code/);
  inviteCode = fresh;
});

test("a lead can promote a member, and the group always keeps a lead", async () => {
  const leadId = memberOf(lead, "Lena").id;
  await lead.controller.handle({ type: "setRole", userId: leadId, role: "member" });
  assert.match(lead.last().error!, /at least one lead/);

  await lead.controller.handle({ type: "setRole", userId: memberOf(lead, "Ann").id, role: "lead" });
  assert.equal(lead.last().error, null);
  assert.equal(memberOf(lead, "Ann").role, "lead");
  await ann.controller.refresh();
  assert.equal(ann.last().team!.role, "lead");

  // With two leads, one can step down.
  await ann.controller.handle({ type: "setRole", userId: leadId, role: "member" });
  assert.equal(ann.last().error, null);
  await ann.controller.handle({ type: "setRole", userId: leadId, role: "lead" });
});

test("the only lead can't leave a group that still has people", async () => {
  await ann.controller.handle({ type: "setRole", userId: memberOf(ann, "Ann").id, role: "member" });
  assert.equal(ann.last().error, null);
  await lead.controller.handle({ type: "leaveTeam" });
  assert.match(lead.last().error!, /only lead/);
  assert.equal(lead.last().team!.id, teamId);
});

test("removing someone keeps what they did, without their name", async () => {
  const benId = benUser.id;
  const { error } = await admin.from("events").insert({ team_id: teamId, user_id: benId, summary: "Ben did a thing" });
  assert.ifError(error);
  await lead.controller.handle({ type: "removeMember", userId: benId });
  assert.equal(lead.last().error, null);
  assert.equal(lead.last().members.length, 2);
  assert.ok(!lead.last().members.some((member) => member.name === "Ben"));
  const kept = lead.last().feed.find((item) => item.summary === "Ben did a thing");
  assert.ok(kept, "the progress stays in the feed");
  assert.equal(kept!.author, "A teammate");

  await ben.controller.refresh();
  assert.equal(ben.last().team, null, "Ben is out of the group");
  assert.equal(ben.last().teams.length, 0);

  await lead.controller.handle({ type: "removeMember", userId: leadUser.id });
  assert.match(lead.last().error!, /leave/);
});

test("the profile name changes in every group, and the password can be changed", async () => {
  await lead.controller.handle({ type: "updateProfile", displayName: "  Lena K  " });
  assert.equal(lead.last().error, null);
  assert.equal(lead.last().user!.displayName, "Lena K");
  assert.equal(memberOf(lead, "Lena K").role, "lead");
  await lead.controller.handle({ type: "updateProfile", displayName: " " });
  assert.match(lead.last().error!, /empty/);

  await lead.controller.handle({ type: "changePassword", password: "new-secret-1", confirmPassword: "new-secret-2" });
  assert.match(lead.last().error!, /don't match/);

  await lead.controller.handle({ type: "changePassword", password: "new-secret-1", confirmPassword: "new-secret-1" });
  assert.equal(lead.last().error, null);
  assert.match(lead.last().notice!, /Password changed/);
  const again = sidebar("lead-again");
  await again.controller.handle({ type: "signIn", email: leadUser.email, password: "new-secret-1" });
  assert.equal(again.last().error, null);
  assert.ok(again.last().user);
});

test("a member can leave, and the last person leaving removes the group", async () => {
  await ann.controller.handle({ type: "leaveTeam" });
  assert.equal(ann.last().error, null);
  assert.equal(ann.last().team, null);
  await lead.controller.refresh();
  assert.equal(lead.last().members.length, 1);

  await lead.controller.handle({ type: "leaveTeam" });
  assert.equal(lead.last().error, null);
  const { data } = await admin.from("teams").select("id").eq("id", teamId);
  assert.equal(data!.length, 0);
});

test("a lead deletes the group with everything in it", async () => {
  await lead.controller.handle({ type: "createTeam", name: "Doomed", displayName: "Lena K" });
  const doomed = lead.last().team!.id;
  teamIds.add(doomed);
  await lead.controller.handle({ type: "addTask", title: "A task that goes too" });
  await lead.controller.handle({ type: "deleteTeam" });
  assert.equal(lead.last().error, null);
  assert.equal(lead.last().team, null);
  assert.equal(lead.last().teams.length, 0);
  const { data } = await admin.from("tasks").select("id").eq("team_id", doomed);
  assert.equal(data!.length, 0);
});
