// Runs the real Hacky Git script in a simulated browser.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { layout } from "./gitTree.js";

const SCRIPT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../media/git.js"), "utf8");

function mount() {
  const sent: any[] = [];
  const dom = new JSDOM('<!DOCTYPE html><div id="root"></div>', { runScripts: "outside-only" });
  const window = dom.window as any;
  window.acquireVsCodeApi = () => ({ postMessage: (message: unknown) => sent.push(JSON.parse(JSON.stringify(message))) });
  window.eval(SCRIPT);
  const root = window.document.getElementById("root");
  const send = (state: unknown) => window.dispatchEvent(new window.MessageEvent("message", { data: state }));
  return { sent, send, root };
}

const raw = (hash: string, parents: string[], author: string, subject: string, refs: string[] = []) => ({ hash, short: hash.slice(0, 7), parents, author, time: Math.floor(Date.now() / 1000) - 3600, subject, refs });
const { commits, lanes } = layout([
  raw("m000000", ["x000000", "f000000"], "Alice", "merge feature", ["HEAD", "main", "origin/main"]),
  raw("f000000", ["b000000"], "Bob", "<img src=x onerror=alert(1)>", ["feature"]),
  raw("x000000", ["b000000"], "Zed", "main work"),
  raw("b000000", [], "Alice", "first", ["tag: v1"]),
]);
const GRAPH = {
  repo: "demo",
  commits,
  lanes,
  head: "main",
  detached: false,
  capped: false,
  branches: [
    { name: "main", remote: false, tip: "m", current: true, upstream: "origin/main", ahead: 2, behind: 0, gone: false, time: 1 },
    { name: "origin/main", remote: true, tip: "m", current: false, upstream: null, ahead: 0, behind: 0, gone: false, time: 1 },
  ],
};
const BASE = {
  user: { email: "a@example.com", displayName: "Alice" },
  team: { id: "t" },
  members: [{ id: "1", name: "Alice", me: true }, { id: "2", name: "bob", me: false }],
  folder: "demo",
  git: { status: "ok", error: null, graph: GRAPH, loadedAt: 1 },
};

test("asks the controller to read the repository once per folder", () => {
  const { sent, send } = mount();
  send({ ...BASE, git: { status: "idle", error: null, graph: null, loadedAt: null } });
  send({ ...BASE, git: { status: "idle", error: null, graph: null, loadedAt: null } });
  assert.equal(sent.filter((m) => m.type === "loadGit").length, 1);
  send({ ...BASE, folder: "other", git: { status: "idle", error: null, graph: null, loadedAt: null } });
  assert.equal(sent.filter((m) => m.type === "loadGit").length, 2);
});

test("draws a dot per commit, lines to parents, and labels refs", () => {
  const { send, root } = mount();
  send(BASE);
  assert.equal(root.querySelectorAll("circle").length, 4);
  assert.equal(root.querySelectorAll("path").length, 4, "m has two parents, f and x one each");
  assert.equal(root.querySelectorAll(".crow").length, 4);
  const chips = [...root.querySelectorAll(".crow .chip")].map((c: any) => c.textContent);
  assert.deepEqual(chips, ["HEAD", "main", "origin/main", "feature", "v1"]);
  assert.match(root.textContent, /on main/);
  assert.match(root.textContent, /Branches \(2\)/);
  assert.match(root.textContent, /checked out · 2 ahead/);
});

test("commit text is never turned into HTML", () => {
  const { send, root } = mount();
  send(BASE);
  assert.equal(root.querySelector("img"), null);
  assert.ok([...root.querySelectorAll(".subject")].some((n: any) => n.textContent === "<img src=x onerror=alert(1)>"));
});

test("authors matching a teammate are marked, and you are named as you", () => {
  const { send, root } = mount();
  send(BASE);
  const who = [...root.querySelectorAll(".who")].map((n: any) => n.textContent);
  assert.ok(who.includes("AAlice (you)"));
  assert.equal(root.querySelectorAll(".who.me").length, 2);
  assert.equal(root.querySelectorAll(".av.team").length, 3, "Alice twice and bob once; Zed isn't on the team");
});

test("shows errors, empty repos and the refresh button", () => {
  const { send, root, sent } = mount();
  send({ ...BASE, git: { status: "error", error: "This folder isn't a git repository.", graph: null, loadedAt: null } });
  assert.match(root.querySelector('[role="alert"]').textContent, /isn't a git repository/);
  send({ ...BASE, git: { status: "ok", error: null, graph: { ...GRAPH, commits: [], lanes: 0, branches: [], head: null }, loadedAt: 1 } });
  assert.match(root.textContent, /No commits yet/);
  [...root.querySelectorAll("button")].find((b: any) => b.textContent === "Refresh").click();
  assert.equal(sent.at(-1).type, "loadGit");
});

test("asks to log in first", () => {
  const { send, root } = mount();
  send({ ...BASE, user: null });
  assert.match(root.textContent, /Log in and choose a team/);
});
