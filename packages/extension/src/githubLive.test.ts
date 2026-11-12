// The GitHub link and the same-project check against the linked Supabase project: who may link,
// that each person writes only their own folder, and that other teams see nothing.
// Needs supabase/migrations/20261112100000_github_and_project_check.sql applied.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createClient } from "@supabase/supabase-js";
import { HackyApi } from "./api.js";

const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY } = process.env as Record<string, string>;
const admin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const tempDir = mkdtempSync(join(tmpdir(), "hacky-ghlive-"));
const userIds: string[] = [];
const teamIds: string[] = [];
const apis: HackyApi[] = [];

async function person(label: string) {
  const email = `hacky-test-${label}-${randomBytes(6).toString("hex")}@example.com`;
  const password = randomBytes(24).toString("hex");
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(error);
  userIds.push(data.user!.id);
  const api = new HackyApi(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, join(tempDir, `${label}.json`));
  apis.push(api);
  await api.signIn(email, password);
  return { id: data.user!.id, api };
}

let lead: Awaited<ReturnType<typeof person>>;
let member: Awaited<ReturnType<typeof person>>;
let outsider: Awaited<ReturnType<typeof person>>;
let teamId: string;

before(async () => {
  [lead, member, outsider] = await Promise.all([person("ghlead"), person("ghmember"), person("ghoutsider")]);
  teamId = await lead.api.createTeam("GitHub test", "Lead");
  teamIds.push(teamId);
  const code = (await lead.api.listTeams()).find((team) => team.id === teamId)!.invite_code;
  await member.api.joinTeam(code, "Member");
  teamIds.push(await outsider.api.createTeam("Other team", "Outsider"));
});

after(async () => {
  await Promise.all(apis.map((api) => api.dispose()));
  for (const id of teamIds) await admin.from("teams").delete().eq("id", id);
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
  rmSync(tempDir, { recursive: true, force: true });
});

test("only a lead links and unlinks the repository, and the team sees it", async () => {
  await assert.rejects(member.api.linkGithubRepo(teamId, "puhita/hacky"), /Only a group lead/);
  await lead.api.linkGithubRepo(teamId, "puhita/hacky");
  const seen = await member.api.githubLink(teamId);
  assert.equal(seen?.repo, "puhita/hacky");
  assert.equal(seen?.linkedBy, "Lead");
  assert.equal(await outsider.api.githubLink(teamId), null, "another team sees nothing");
  await lead.api.linkGithubRepo(teamId, "puhita/other");
  assert.equal((await member.api.githubLink(teamId))?.repo, "puhita/other", "linking again replaces it");
  await assert.rejects(lead.api.linkGithubRepo(teamId, "../x"));
  await lead.api.unlinkGithubRepo(teamId);
  assert.equal(await member.api.githubLink(teamId), null);
});

test("each person reports their own folder, the team reads all of them, others read none", async () => {
  const root = "a".repeat(40);
  await lead.api.reportFingerprint(teamId, { folderName: "app", rootCommit: root, remote: "github.com/puhita/hacky" });
  await member.api.reportFingerprint(teamId, { folderName: "game", rootCommit: "b".repeat(40), remote: null });
  await member.api.reportFingerprint(teamId, { folderName: "app", rootCommit: root, remote: null });
  const prints = await lead.api.projectFingerprints(teamId);
  assert.equal(prints.length, 2, "one row per person, updated in place");
  assert.deepEqual(prints.find((print) => print.name === "Member")?.folderName, "app");
  assert.equal((await outsider.api.projectFingerprints(teamId)).length, 0);
  // Nobody can write someone else's row, even straight through the database.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = (lead.api as unknown as { supabase: any }).supabase;
  await client.from("project_fingerprints").update({ folder_name: "hijacked" }).eq("team_id", teamId).eq("user_id", member.id);
  assert.equal((await member.api.projectFingerprints(teamId)).find((print) => print.name === "Member")?.folderName, "app");
  const { error } = await client.from("project_fingerprints").insert({ team_id: teamId, user_id: member.id, folder_name: "x" });
  assert.ok(error, "inserting a row for someone else is refused");
});
