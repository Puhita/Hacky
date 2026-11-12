import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  checkTokenShape,
  compareProjects,
  deleteToken,
  fetchGithubOverview,
  githubRepoOf,
  normalizeRemote,
  parseRepo,
  readFingerprint,
  readToken,
  writeToken,
  type GithubFetch,
  type MemberFingerprint,
} from "./github.js";

test("parseRepo takes owner/name, links and clone URLs", () => {
  assert.equal(parseRepo("Puhita/Hacky"), "Puhita/Hacky");
  assert.equal(parseRepo("https://github.com/Puhita/Hacky"), "Puhita/Hacky");
  assert.equal(parseRepo("https://github.com/Puhita/Hacky/tree/main/src"), "Puhita/Hacky");
  assert.equal(parseRepo("https://github.com/Puhita/Hacky.git"), "Puhita/Hacky");
  assert.equal(parseRepo("git@github.com:Puhita/Hacky.git"), "Puhita/Hacky");
  assert.equal(parseRepo("github.com/Puhita/Hacky/"), "Puhita/Hacky");
  assert.throws(() => parseRepo("https://gitlab.com/a/b"), /github\.com/);
  assert.throws(() => parseRepo("just-a-name"), /owner\/name/);
  assert.throws(() => parseRepo("../etc"), /owner\/name/);
});

test("normalizeRemote gives the same text for every clone of a repository", () => {
  const forms = ["https://github.com/Puhita/Hacky.git", "https://user:secret@github.com/Puhita/Hacky", "git@github.com:Puhita/Hacky.git", "ssh://git@github.com:22/Puhita/Hacky.git"];
  for (const form of forms) assert.equal(normalizeRemote(form), "github.com/puhita/hacky", form);
  assert.equal(normalizeRemote("https://gitlab.com/team/app.git"), "gitlab.com/team/app");
  assert.equal(normalizeRemote("C:\\repos\\app"), null);
  assert.equal(normalizeRemote("../app"), null);
  assert.equal(normalizeRemote("file:///c/repos/app"), null);
  assert.equal(normalizeRemote(""), null);
  assert.equal(githubRepoOf("github.com/puhita/hacky"), "puhita/hacky");
  assert.equal(githubRepoOf("gitlab.com/team/app"), null);
});

const member = (userId: string, me = false) => ({ userId, name: userId, me });
const print = (userId: string, rootCommit: string | null, remote: string | null, folderName = "app", me = false): MemberFingerprint => ({
  userId,
  name: userId,
  me,
  folderName,
  rootCommit,
  remote,
  updatedAt: "2026-11-12T10:00:00Z",
});
const A = "a".repeat(40);
const B = "b".repeat(40);

test("without GitHub: folders sharing history are one project, the odd one out is flagged", () => {
  const check = compareProjects(
    [member("ana", true), member("bo"), member("cy"), member("di")],
    [print("ana", A, null, "app", true), print("bo", A, "github.com/x/app"), print("cy", B, "github.com/y/other")],
    null,
  );
  assert.equal(check.status, "mismatch");
  assert.equal(check.basis, "git");
  assert.deepEqual(check.rows.map((row) => row.verdict), ["same", "same", "different", "missing"]);
});

test("without GitHub: a shared remote joins folders even when one is a shallow clone", () => {
  const check = compareProjects([member("ana"), member("bo")], [print("ana", A, "github.com/x/app"), print("bo", null, "github.com/x/app")], null);
  assert.equal(check.status, "ok");
});

test("without GitHub: folders that aren't git repositories can't be compared", () => {
  const check = compareProjects([member("ana"), member("bo")], [print("ana", null, null, "game"), print("bo", null, null, "game")], null);
  assert.equal(check.basis, "none");
  assert.equal(check.status, "unclear");
  assert.ok(check.rows.every((row) => row.verdict === "unknown"));
});

test("with GitHub: folders are compared with the linked repository", () => {
  const check = compareProjects(
    [member("ana"), member("bo"), member("cy"), member("di")],
    [print("ana", A, "github.com/puhita/hacky"), print("bo", A, null), print("cy", B, "github.com/someone/else"), print("di", null, null)],
    "Puhita/Hacky",
  );
  assert.equal(check.basis, "github");
  assert.deepEqual(check.rows.map((row) => row.verdict), ["same", "same", "different", "unknown"]);
  assert.equal(check.status, "mismatch");
});

test("readFingerprint reads a real repository's first commit and remote", () => {
  const dir = mkdtempSync(join(tmpdir(), "hacky-fp-"));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();
    git("init", "-q");
    git("-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "first");
    git("remote", "add", "origin", "https://token@github.com/Puhita/Hacky.git");
    writeFileSync(join(dir, "x.txt"), "x");
    return readFingerprint(dir).then((fingerprint) => {
      assert.equal(fingerprint.rootCommit, git("rev-list", "--max-parents=0", "HEAD").trim());
      assert.equal(fingerprint.remote, "github.com/puhita/hacky");
      assert.ok(fingerprint.folderName.startsWith("hacky-fp-"));
    });
  } finally {
    setTimeout(() => rmSync(dir, { recursive: true, force: true }), 2000).unref();
  }
});

test("readFingerprint on a plain folder gives only its name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hacky-plain-"));
  try {
    const fingerprint = await readFingerprint(dir, async () => {
      throw new Error("not a git repository");
    });
    assert.deepEqual({ ...fingerprint, folderName: "x" }, { folderName: "x", rootCommit: null, remote: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchGithubOverview reads the repository, its pull requests and commits, with the token", async () => {
  const seen: { url: string; auth?: string }[] = [];
  const fake: GithubFetch = async (url, init) => {
    seen.push({ url, auth: init?.headers?.Authorization });
    const body = url.endsWith("/repos/o/r")
      ? { full_name: "o/r", description: "d", private: true, default_branch: "main", html_url: "https://github.com/o/r", stargazers_count: 2, open_issues_count: 1, pushed_at: "2026-11-12T00:00:00Z" }
      : url.includes("/pulls")
        ? [{ number: 7, title: "Add x", user: { login: "bo" }, html_url: "https://github.com/o/r/pull/7", updated_at: "2026-11-12T00:00:00Z", draft: false }]
        : [{ sha: "0123456789", commit: { message: "Fix y\n\nbody", author: { name: "Ana", date: "2026-11-11T00:00:00Z" } }, author: null, html_url: "javascript:alert(1)" }];
    return { ok: true, status: 200, json: async () => body };
  };
  const overview = await fetchGithubOverview("o/r", "ghp_x", fake);
  assert.equal(overview.repo.private, true);
  assert.equal(overview.pulls[0].title, "Add x");
  assert.equal(overview.commits[0].message, "Fix y");
  assert.equal(overview.commits[0].sha, "0123456");
  assert.equal(overview.commits[0].author, "Ana");
  // Links that aren't github.com pages are dropped.
  assert.equal(overview.commits[0].url, "");
  assert.ok(seen.every((call) => call.auth === "Bearer ghp_x"));
});

test("fetchGithubOverview explains a missing or private repository", async () => {
  const fake: GithubFetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  await assert.rejects(fetchGithubOverview("o/r", null, fake), /private, sign in with GitHub/);
  await assert.rejects(fetchGithubOverview("../x", null, fake), /repository name/);
});

test("the token is kept in a local file and can be removed", () => {
  const dir = mkdtempSync(join(tmpdir(), "hacky-token-"));
  try {
    const file = join(dir, "sub", "github-token");
    assert.equal(readToken(file), null);
    writeToken(file, "github_pat_abc");
    assert.equal(readToken(file), "github_pat_abc");
    deleteToken(file);
    assert.equal(readToken(file), null);
    assert.equal(checkTokenShape(" ghp_abcdefghijklmnopqrstuvwxyz0123 "), "ghp_abcdefghijklmnopqrstuvwxyz0123");
    assert.throws(() => checkTokenShape("password123"), /GitHub token/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the device flow starts, waits, slows down and hands back a token", async () => {
  const { startDeviceFlow, pollDeviceFlow } = await import("./github.js");
  const answers = [{ error: "authorization_pending" }, { error: "slow_down", interval: 10 }, { access_token: "gho_abc" }];
  const posts: { url: string; body?: string; method?: string }[] = [];
  const fake: GithubFetch = async (url, init) => {
    posts.push({ url, body: init?.body, method: init?.method });
    const body = url.endsWith("/login/device/code")
      ? { device_code: "dev1", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", interval: 5, expires_in: 900 }
      : answers.shift();
    return { ok: true, status: 200, json: async () => body };
  };
  const flow = await startDeviceFlow("client1", fake, 1000);
  assert.deepEqual(flow, { deviceCode: "dev1", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", intervalSeconds: 5, expiresAt: 901_000 });
  assert.equal(posts[0].method, "POST");
  assert.match(posts[0].body ?? "", /client_id=client1/);
  assert.match(posts[0].body ?? "", /scope=repo\+read%3Auser/);
  assert.deepEqual(await pollDeviceFlow("client1", "dev1", fake), { kind: "pending" });
  assert.deepEqual(await pollDeviceFlow("client1", "dev1", fake), { kind: "slow_down", intervalSeconds: 10 });
  assert.deepEqual(await pollDeviceFlow("client1", "dev1", fake), { kind: "token", token: "gho_abc" });
  assert.match(posts[1].body ?? "", /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code/);
});

test("the device flow explains a disabled app, a denial and a code from somewhere else", async () => {
  const { startDeviceFlow, pollDeviceFlow } = await import("./github.js");
  const reply = (body: unknown): GithubFetch => async () => ({ ok: true, status: 200, json: async () => body });
  await assert.rejects(startDeviceFlow("c", reply({ error: "device_flow_disabled" })), /Enable Device Flow/);
  await assert.rejects(startDeviceFlow("c", reply({ device_code: "d", user_code: "u", verification_uri: "https://evil.example/login" })), /unexpected/);
  assert.deepEqual(await pollDeviceFlow("c", "d", reply({ error: "access_denied" })), { kind: "error", message: "Sign-in was cancelled on GitHub." });
  assert.equal((await pollDeviceFlow("c", "d", reply({ error: "expired_token" }))).kind, "error");
});

test("the account file keeps the login, and an older bare token still reads", async () => {
  const { readAccount, writeAccount } = await import("./github.js");
  const dir = mkdtempSync(join(tmpdir(), "hacky-account-"));
  try {
    const file = join(dir, "github-token");
    writeAccount(file, { token: "gho_x", login: "ana", via: "signin" });
    assert.deepEqual(readAccount(file), { token: "gho_x", login: "ana", via: "signin" });
    assert.equal(readToken(file), "gho_x");
    writeToken(file, "ghp_old");
    assert.deepEqual(readAccount(file), { token: "ghp_old", login: "", via: "token" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchMyRepos lists the person's repositories and drops odd names", async () => {
  const { fetchMyRepos } = await import("./github.js");
  const fake: GithubFetch = async (url, init) => {
    assert.match(url, /\/user\/repos\?sort=pushed/);
    assert.equal(init?.headers?.Authorization, "Bearer gho_x");
    return { ok: true, status: 200, json: async () => [{ full_name: "ana/app", private: true, pushed_at: "2026-11-12T00:00:00Z" }, { full_name: "../x" }] };
  };
  assert.deepEqual(await fetchMyRepos("gho_x", fake), [{ fullName: "ana/app", private: true, pushedAt: "2026-11-12T00:00:00Z" }]);
});
