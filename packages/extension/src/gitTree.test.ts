import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { layout, parseLog, readGit } from "./gitTree.js";

const commit = (hash: string, ...parents: string[]) => ({ hash, short: hash, parents, author: "A", time: 0, subject: hash, refs: [] as string[] });

test("a straight history stays in one lane", () => {
  const { commits, lanes } = layout([commit("c", "b"), commit("b", "a"), commit("a")]);
  assert.equal(lanes, 1);
  assert.deepEqual(commits.map((c) => c.lane), [0, 0, 0]);
  assert.deepEqual(commits[0].edges, [{ parent: "b", slot: 0 }]);
});

test("a branch and its merge use a second lane and rejoin", () => {
  // m merges f (feature) into main; both come from base.
  const { commits, lanes } = layout([commit("m", "x", "f"), commit("f", "base"), commit("x", "base"), commit("base")]);
  assert.equal(lanes, 2);
  const byHash = Object.fromEntries(commits.map((c) => [c.hash, c]));
  assert.equal(byHash.m.lane, 0);
  assert.deepEqual(byHash.m.edges, [{ parent: "x", slot: 0 }, { parent: "f", slot: 1 }]);
  assert.equal(byHash.f.lane, 1);
  assert.equal(byHash.x.lane, 0);
  assert.equal(byHash.base.lane, 0, "both lines end at the shared base");
});

test("two unrelated branch tips get their own lanes", () => {
  const { commits, lanes } = layout([commit("a2", "a1"), commit("b2", "b1"), commit("a1"), commit("b1")]);
  assert.equal(lanes, 2);
  assert.deepEqual(commits.map((c) => c.lane), [0, 1, 0, 1]);
});

test("a parent that was cut off by the commit limit still gets a line", () => {
  const { commits } = layout([commit("b", "missing")]);
  assert.deepEqual(commits[0].edges, [{ parent: "missing", slot: 0 }]);
});

test("reads git's log records, with and without refs", () => {
  const text = "aaa\x1fbbb ccc\x1fAda\x1f1700000000\x1fHEAD -> main, origin/main, tag: v1\x1fMerge it\x1e\nbbb\x1f\x1fBob\x1f1690000000\x1f\x1fFirst\x1e\n";
  const [a, b] = parseLog(text);
  assert.deepEqual(a.parents, ["bbb", "ccc"]);
  assert.deepEqual(a.refs, ["main", "origin/main", "tag: v1", "HEAD"]);
  assert.equal(a.author, "Ada");
  assert.deepEqual(b.parents, []);
  assert.deepEqual(b.refs, []);
});

let dir: string;
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Ada", "-c", "user.email=ada@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hacky-git-"));
  git("init", "-q", "-b", "main");
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

test("reads a real repository with a branch and a merge", async () => {
  writeFileSync(join(dir, "a.txt"), "1");
  git("add", "."); git("commit", "-q", "-m", "first");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, "b.txt"), "2");
  git("add", "."); git("commit", "-q", "-m", "feature work");
  git("checkout", "-q", "main");
  writeFileSync(join(dir, "c.txt"), "3");
  git("add", "."); git("commit", "-q", "-m", "main work");
  git("merge", "-q", "--no-ff", "feature", "-m", "merge feature");
  git("tag", "v1");

  const graph = await readGit(dir);
  assert.equal(graph.head, "main");
  assert.equal(graph.detached, false);
  assert.equal(graph.commits[0].subject, "merge feature");
  assert.deepEqual(graph.commits.map((c) => c.subject).sort(), ["feature work", "first", "main work", "merge feature"]);
  assert.equal(graph.commits.at(-1)!.subject, "first");
  assert.equal(graph.commits[0].parents.length, 2);
  assert.ok(graph.commits[0].refs.includes("HEAD") && graph.commits[0].refs.includes("main") && graph.commits[0].refs.includes("tag: v1"));
  assert.equal(graph.lanes, 2);
  assert.equal(graph.commits[0].author, "Ada");
  assert.deepEqual(graph.branches.map((b) => [b.name, b.current]), [["main", true], ["feature", false]].sort((a, b) => Number(b[1]) - Number(a[1])));
  assert.equal(graph.capped, false);
});

test("an empty repo, a detached HEAD, and a folder that isn't a repo", async () => {
  const empty = await readGit(dir);
  assert.deepEqual([empty.commits.length, empty.branches.length], [0, 0]);
  writeFileSync(join(dir, "a.txt"), "1");
  git("add", "."); git("commit", "-q", "-m", "first");
  git("checkout", "-q", "--detach");
  const detached = await readGit(dir);
  assert.equal(detached.detached, true);
  assert.equal(detached.head, null);
  const outside = mkdtempSync(join(tmpdir(), "hacky-nogit-"));
  try {
    await assert.rejects(readGit(outside), /isn't a git repository/);
  } finally {
    rmSync(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a weird commit subject can't break the record parsing", async () => {
  writeFileSync(join(dir, "a.txt"), "1");
  git("add", ".");
  git("commit", "-q", "-m", "<img src=x onerror=alert(1)> | ; `rm -rf`");
  const graph = await readGit(dir);
  assert.equal(graph.commits[0].subject, "<img src=x onerror=alert(1)> | ; `rm -rf`");
});
