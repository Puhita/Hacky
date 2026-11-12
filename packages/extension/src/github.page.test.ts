// The GitHub and same-project sections of the board's Project tab, and the sidebar warning, in a simulated browser.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const media = (name: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), `../media/${name}`), "utf8");

function mount(script: string, saved: unknown = undefined) {
  const sent: any[] = [];
  const dom = new JSDOM('<!DOCTYPE html><div id="root"></div>', { runScripts: "outside-only" });
  const window = dom.window as any;
  let state = saved;
  window.acquireVsCodeApi = () => ({
    postMessage: (message: unknown) => sent.push(JSON.parse(JSON.stringify(message))),
    getState: () => state,
    setState: (value: unknown) => (state = JSON.parse(JSON.stringify(value))),
  });
  window.eval(script);
  const send = (data: unknown) => window.dispatchEvent(new window.MessageEvent("message", { data }));
  const root = window.document.getElementById("root");
  const button = (text: string) => [...root.querySelectorAll("button")].find((node: any) => node.textContent.startsWith(text)) as any;
  return { sent, send, root, window, button };
}

const TEAM = { id: "t1", name: "Team One", invite_code: "abc123", role: "lead", members: 2 };
const CHECK = {
  status: "mismatch",
  basis: "git",
  rows: [
    { userId: "u1", name: "Alice", me: true, verdict: "same", reason: "Same history as the others.", folderName: "app", remote: null, updatedAt: null },
    { userId: "u2", name: "Bob", me: false, verdict: "different", reason: "Folder game has a different history.", folderName: "game", remote: null, updatedAt: null },
  ],
};
const base = {
  user: { email: "a@example.com", displayName: "Alice" },
  teams: [TEAM],
  team: TEAM,
  members: [
    { id: "u1", name: "Alice", role: "lead", me: true },
    { id: "u2", name: "Bob", role: "member", me: false },
  ],
  workspace: "connected",
  inbox: [],
  assumptions: [],
  decisions: [],
  tasks: [],
  project: { overview: { idea: "", architecture: "", updatedBy: null, updatedAt: null }, items: [] },
  fileTouches: [],
  feed: [],
  pulse: [],
  agentChat: [],
  skills: { team: [], lookup: null, fromTeam: false },
  git: { status: "idle", error: null, graph: null, loadedAt: null },
  github: { link: null, hasToken: false, folderRepo: "puhita/hacky", status: "idle", error: null, overview: null, loadedAt: null, check: CHECK },
  map: { project: "", owners: [], chats: [], threads: [], unassigned: [], decisions: [], stats: { tasks: { todo: 0, in_progress: 0, done: 0 }, openQuestions: 0, decisions: 0, activeChats: 0 }, timeline: { from: "", items: [] } },
  notice: null,
  error: null,
};

test("a lead links the folder's GitHub repository from the Project tab", () => {
  const { send, root, sent, button } = mount(media("board.js"), { tab: "project" });
  send(base);
  assert.match(root.textContent, /Link the repository your group works in/);
  button("Link puhita/hacky").click();
  assert.deepEqual(sent.at(-1), { type: "linkGithub", repo: "puhita/hacky" });
});

test("the same-project check names who is in a different project", () => {
  const { send, root } = mount(media("board.js"), { tab: "project" });
  send(base);
  assert.match(root.querySelector(".same-sum").textContent, /different project/);
  const rows = [...root.querySelectorAll(".same-row")].map((row: any) => row.textContent);
  assert.match(rows[0], /Alice \(you\).*Same project/);
  assert.match(rows[1], /Bob.*Different project/);
});

test("a linked repository shows its pull requests and commits, and links open through the app", () => {
  const { send, root, sent, button } = mount(media("board.js"), { tab: "project" });
  send({
    ...base,
    github: {
      ...base.github,
      link: { repo: "puhita/hacky", linkedBy: "Alice", linkedAt: new Date().toISOString() },
      status: "ok",
      hasToken: true,
      overview: {
        repo: { fullName: "puhita/hacky", description: "Team tool", private: true, defaultBranch: "main", url: "https://github.com/puhita/hacky", stars: 0, openIssues: 0, pushedAt: null },
        pulls: [{ number: 7, title: "Add x", author: "bob", url: "https://github.com/puhita/hacky/pull/7", updatedAt: new Date().toISOString(), draft: false }],
        commits: [{ sha: "abc1234", message: "Fix y", author: "alice", url: "https://github.com/puhita/hacky/commit/abc1234", date: new Date().toISOString() }],
      },
    },
  });
  assert.match(root.textContent, /Add x/);
  assert.match(root.textContent, /Fix y/);
  assert.match(root.textContent, /stays on this computer/);
  button("#7").click();
  assert.deepEqual(sent.at(-1), { type: "openGithubLink", url: "https://github.com/puhita/hacky/pull/7" });
  button("Unlink").click();
  assert.deepEqual(sent.at(-1), { type: "unlinkGithub" });
});

test("a member who isn't a lead can't link, but can save a token", () => {
  const { send, root, sent, window } = mount(media("board.js"), { tab: "project" });
  send({ ...base, team: { ...TEAM, role: "member" }, teams: [{ ...TEAM, role: "member" }] });
  assert.match(root.textContent, /A group lead can link it/);
  const input = root.querySelector("#gh-token");
  input.value = "github_pat_123";
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter" }));
  assert.deepEqual(sent.at(-1), { type: "saveGithubToken", token: "github_pat_123" });
});

test("Sign in with GitHub, the code to enter, and picking from your own repositories", () => {
  const { send, root, sent, button } = mount(media("board.js"), { tab: "project" });
  send({ ...base, github: { ...base.github, canSignIn: true } });
  button("Sign in with GitHub").click();
  assert.deepEqual(sent.at(-1), { type: "githubSignIn" });
  assert.ok(root.querySelector(".gh-other"), "a token stays possible");

  send({ ...base, github: { ...base.github, canSignIn: true, signIn: { userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresAt: Date.now() + 900_000 } } });
  assert.equal(root.querySelector(".gh-code").textContent, "ABCD-1234");
  button("Open GitHub").click();
  assert.deepEqual(sent.at(-1), { type: "openGithubLink", url: "https://github.com/login/device" });
  button("Cancel").click();
  assert.deepEqual(sent.at(-1), { type: "githubCancelSignIn" });

  send({
    ...base,
    github: { ...base.github, canSignIn: true, hasToken: true, account: { login: "ana", via: "signin" }, myRepos: [{ fullName: "ana/app", private: true, pushedAt: null }] },
  });
  assert.match(root.textContent, /Signed in to GitHub as ana/);
  assert.match(root.querySelector(".gh-pick").textContent, /ana\/app.*private/);
  root.querySelector(".gh-pick button").click();
  assert.deepEqual(sent.at(-1), { type: "linkGithub", repo: "ana/app" });
  button("Sign out of GitHub").click();
  assert.deepEqual(sent.at(-1), { type: "removeGithubToken" });
});

test("the sidebar warns when someone's folder is a different project", () => {
  const { send, root } = mount(media("sidebar.js"));
  send(base);
  const warning = root.querySelector(".proj-warn");
  assert.ok(warning, "warning shown");
  assert.match(warning.textContent, /Bob's folder looks like a different project/);
  send({ ...base, github: { ...base.github, check: { ...CHECK, status: "ok" } } });
  assert.equal(root.querySelector(".proj-warn"), null);
});
