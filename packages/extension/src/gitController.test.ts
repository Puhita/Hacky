// The Git screen's data through the sidebar controller. Needs no signed-in user.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { HackyApi } from "./api.js";
import { SidebarController, type SidebarState } from "./controller.js";

const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = process.env as Record<string, string>;
const temp = mkdtempSync(join(tmpdir(), "hacky-gitctl-"));
const disposers: (() => void)[] = [];
after(() => {
  for (const dispose of disposers) dispose();
  rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function controllerFor(folder: string | null) {
  const api = new HackyApi(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, join(temp, "creds.json"));
  const states: SidebarState[] = [];
  const controller = new SidebarController({
    api,
    supabaseUrl: SUPABASE_URL,
    publishableKey: SUPABASE_PUBLISHABLE_KEY,
    workspaceDir: () => folder,
    loadTeamId: () => undefined,
    saveTeamId: () => undefined,
    post: (state) => states.push(state),
  });
  disposers.push(() => controller.dispose(), () => api.dispose());
  return { controller, last: () => states.at(-1)! };
}

test("starts idle, then loads the folder's repository when asked", async () => {
  const repo = mkdtempSync(join(temp, "repo-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Ada", "-c", "user.email=a@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: repo });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "1");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  const { controller, last } = controllerFor(repo);
  await controller.handle({ type: "ready" });
  assert.equal(last().git.status, "idle");
  await controller.handle({ type: "loadGit" });
  assert.equal(last().git.status, "ok");
  assert.equal(last().git.graph?.commits[0].subject, "first");
  assert.equal(last().git.graph?.head, "main");
});

test("says so when there is no folder or it is not a repository", async () => {
  const none = controllerFor(null);
  await none.controller.handle({ type: "loadGit" });
  assert.deepEqual([none.last().git.status, none.last().git.error], ["error", "Choose a project folder first."]);
  const plain = controllerFor(mkdtempSync(join(temp, "plain-")));
  await plain.controller.handle({ type: "loadGit" });
  assert.match(plain.last().git.error ?? "", /isn't a git repository/);
});
