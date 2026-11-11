// Skills through the sidebar controller, with a pretend GitHub and the linked Supabase project.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createClient } from "@supabase/supabase-js";
import { HackyApi } from "./api.js";
import { SidebarController, type SidebarState } from "./controller.js";
import type { Fetch } from "./skills.js";

const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY } = process.env as Record<string, string>;
const admin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const SHA = "b".repeat(40);
const SHA2 = "c".repeat(40);

const tempDir = mkdtempSync(join(tmpdir(), "hacky-skills-ctl-"));
const userIds: string[] = [];
const teamIds = new Set<string>();
const disposers: (() => void | Promise<void>)[] = [];

// A pretend GitHub whose single skill can be moved to a newer commit.
let currentSha = SHA;
let body = "Talk short.";
const reply = (value: unknown, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => value,
  text: async () => String(value),
  arrayBuffer: async () => new TextEncoder().encode(String(value)).buffer as ArrayBuffer,
});
const github: Fetch = async (url) => {
  if (url.includes("/commits/")) return reply({ sha: currentSha });
  if (url.includes("/git/trees/")) return reply({ truncated: false, tree: [{ path: "skills/caveman/SKILL.md", type: "blob", mode: "100644", size: 11 }] });
  if (url.includes("raw.githubusercontent.com")) return reply(body);
  return reply("no", 404);
};

function person(label: string, workspace: string | null) {
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
    fetch: github,
  });
  disposers.push(() => controller.dispose(), () => api.dispose());
  return { api, controller, last: () => states.at(-1)! };
}

async function confirmedUser(label: string) {
  const email = `hacky-test-${label}-${randomBytes(6).toString("hex")}@example.com`;
  const password = randomBytes(24).toString("hex");
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(error);
  userIds.push(data.user!.id);
  return { email, password };
}

let aliceDir: string;
let bobDir: string;
let alice: ReturnType<typeof person>;
let bob: ReturnType<typeof person>;
let outsider: ReturnType<typeof person>;

before(async () => {
  aliceDir = mkdtempSync(join(tmpdir(), "hacky-alice-"));
  bobDir = mkdtempSync(join(tmpdir(), "hacky-bob-"));
  alice = person("alice", aliceDir);
  bob = person("bob", bobDir);
  outsider = person("outsider", null);
  for (const [who, label] of [[alice, "alice"], [bob, "bob"], [outsider, "outsider"]] as const) {
    await who.controller.handle({ type: "signIn", ...(await confirmedUser(label)) });
  }
  await alice.controller.handle({ type: "createTeam", name: "Skills", displayName: "Alice" });
  teamIds.add(alice.last().team!.id);
  await bob.controller.handle({ type: "joinTeam", code: alice.last().team!.invite_code, displayName: "Bob" });
  await outsider.controller.handle({ type: "createTeam", name: "Elsewhere", displayName: "Eve" });
  teamIds.add(outsider.last().team!.id);
});

after(async () => {
  for (const dispose of disposers) await dispose();
  for (const id of teamIds) await admin.from("teams").delete().eq("id", id);
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
  for (const dir of [tempDir, aliceDir, bobDir]) rmSync(dir, { recursive: true, force: true });
});

test("looking a skill up shows a preview and installs nothing", async () => {
  await alice.controller.handle({ type: "previewSkill", url: "https://github.com/o/r" });
  const lookup = alice.last().skills.lookup;
  assert.equal(lookup?.kind, "preview");
  assert.equal(lookup?.kind === "preview" && lookup.preview.sha, SHA);
  assert.equal(existsSync(join(aliceDir, ".claude/skills")), false);
  await alice.controller.handle({ type: "cancelSkill" });
  assert.equal(alice.last().skills.lookup, null);
});

test("a link that isn't GitHub is refused with a plain message", async () => {
  await alice.controller.handle({ type: "previewSkill", url: "https://evil.example/o/r" });
  assert.match(alice.last().error ?? "", /Only github\.com/);
});

test("installing and sharing puts the skill on the team list, and a teammate installs the same commit", async () => {
  await alice.controller.handle({ type: "previewSkill", url: "o/r" });
  await alice.controller.handle({ type: "installSkill", share: true });
  assert.equal(alice.last().error, null);
  assert.equal(readFileSync(join(aliceDir, ".claude/skills/caveman/SKILL.md"), "utf8"), "Talk short.");
  const mine = alice.last().skills.team[0];
  assert.deepEqual([mine.name, mine.repo, mine.path, mine.sha, mine.local, mine.addedBy], ["caveman", "o/r", "skills/caveman", SHA, "current", "Alice"]);

  await bob.controller.handle({ type: "ready" });
  const theirs = bob.last().skills.team[0];
  assert.equal(theirs.local, "none");
  // The mainline moves on, but Bob still gets the commit the team pinned.
  currentSha = SHA2;
  body = "CHANGED";
  await bob.controller.handle({ type: "previewTeamSkill", skillId: theirs.id });
  const lookup = bob.last().skills.lookup;
  assert.equal(lookup?.kind === "preview" && lookup.preview.sha, SHA);
  assert.equal(bob.last().skills.fromTeam, true);
  await bob.controller.handle({ type: "installSkill", share: true });
  assert.equal(bob.last().skills.team[0].local, "current");
  assert.equal(bob.last().skills.team.length, 1, "installing a teammate's skill doesn't add a second entry");
});

test("a newer commit shows as outdated until the person previews and installs it", async () => {
  await alice.controller.handle({ type: "previewSkill", url: "o/r" });
  assert.equal(alice.last().skills.lookup?.kind === "preview" && alice.last().skills.lookup && (alice.last().skills.lookup as any).preview.sha, SHA2);
  await alice.controller.handle({ type: "installSkill", share: true });
  assert.equal(alice.last().skills.team[0].sha, SHA2);
  assert.equal(readFileSync(join(aliceDir, ".claude/skills/caveman/SKILL.md"), "utf8"), "CHANGED");
  await bob.controller.handle({ type: "ready" });
  assert.equal(bob.last().skills.team[0].local, "outdated");
});

test("another team can't see the list", async () => {
  await outsider.controller.handle({ type: "ready" });
  assert.deepEqual(outsider.last().skills.team, []);
  const { data } = await outsider.api.teamSkills(alice.last().team!.id).then((rows) => ({ data: rows }));
  assert.deepEqual(data, [], "RLS hides it even when asked by team id");
});

test("removing from the folder keeps the team entry, and unsharing keeps the folder copy", async () => {
  await bob.controller.handle({ type: "removeLocalSkill", name: "caveman" });
  assert.equal(existsSync(join(bobDir, ".claude/skills/caveman")), false);
  assert.equal(bob.last().skills.team[0].local, "none");
  await alice.controller.handle({ type: "unshareSkill", skillId: alice.last().skills.team[0].id });
  assert.deepEqual(alice.last().skills.team, []);
  assert.equal(existsSync(join(aliceDir, ".claude/skills/caveman/SKILL.md")), true);
});

test("installing needs a folder", async () => {
  await outsider.controller.handle({ type: "previewSkill", url: "o/r" });
  await outsider.controller.handle({ type: "installSkill" });
  assert.match(outsider.last().error ?? "", /Choose a folder/);
});
