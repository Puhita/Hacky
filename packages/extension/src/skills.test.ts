import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { assertSafePath, installedSkill, installSkill, lookUpSkill, parseGithubUrl, previewPicked, removeSkill, skillName, type Fetch } from "./skills.js";

const SHA = "a".repeat(40);
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hacky-skills-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Entry = { path: string; type?: string; mode?: string; size?: number };
// A pretend GitHub: one commit, a tree, and file contents by repo path.
function fakeGithub(entries: Entry[], contents: Record<string, string>, opts: { truncated?: boolean } = {}): { fetch: Fetch; urls: string[] } {
  const urls: string[] = [];
  const reply = (body: unknown, status = 200) => ({
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => String(body),
    arrayBuffer: async () => new TextEncoder().encode(String(body)).buffer as ArrayBuffer,
  });
  const fetch: Fetch = async (url) => {
    urls.push(url);
    if (url.includes("/commits/")) return reply({ sha: SHA });
    if (url.includes("/git/trees/")) {
      return reply({ truncated: opts.truncated ?? false, tree: entries.map((e) => ({ type: "blob", mode: "100644", size: 10, ...e })) });
    }
    const match = /raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{40}\/(.+)$/.exec(url);
    const path = match && decodeURIComponent(match[1]);
    return path && path in contents ? reply(contents[path]) : reply("missing", 404);
  };
  return { fetch, urls };
}

test("reads links to a repo, a folder or the SKILL.md itself", () => {
  assert.deepEqual(parseGithubUrl("https://github.com/JuliusBrussee/caveman"), { repo: "JuliusBrussee/caveman", ref: null, path: "" });
  assert.deepEqual(parseGithubUrl("owner/repo"), { repo: "owner/repo", ref: null, path: "" });
  assert.deepEqual(parseGithubUrl("https://github.com/o/r/tree/main/skills/caveman/"), { repo: "o/r", ref: "main", path: "skills/caveman" });
  assert.deepEqual(parseGithubUrl("https://github.com/o/r/blob/main/skills/caveman/SKILL.md"), { repo: "o/r", ref: "main", path: "skills/caveman" });
  assert.deepEqual(parseGithubUrl("https://github.com/o/r.git"), { repo: "o/r", ref: null, path: "" });
});

test("refuses anything that isn't a github.com link or a safe path", () => {
  assert.throws(() => parseGithubUrl("https://evil.example/o/r"), /Only github\.com/);
  assert.throws(() => parseGithubUrl("http://github.com/o/r"), /Only github\.com/);
  assert.throws(() => parseGithubUrl("https://github.com.evil.example/o/r"), /Only github\.com/);
  assert.throws(() => parseGithubUrl("https://github.com/o"), /Paste a GitHub link/);
  // The URL parser itself collapses "..", so this can never reach a path inside the repo.
  assert.throws(() => parseGithubUrl("https://github.com/o/r/tree/main/../../x"));
  assert.throws(() => parseGithubUrl("o/r/tree/main/../x"), /Unsafe path/);
  assert.throws(() => parseGithubUrl("javascript:alert(1)"), /Paste a GitHub link/);
  for (const bad of ["../x", "a/../b", "/abs", "a//b", "C:/x", "a\\b", "a/./b"]) assert.throws(() => assertSafePath(bad), /Unsafe path|Empty/, bad);
});

test("names a skill after its folder, or the repo when it is at the root", () => {
  assert.equal(skillName("skills/Caveman Talk", "o/r"), "caveman-talk");
  assert.equal(skillName("", "o/My_Repo"), "my_repo");
  assert.throws(() => skillName("", "o/..."), /can't be used/);
});

test("a repo with one skill goes straight to its preview, pinned to the commit", async () => {
  const { fetch } = fakeGithub(
    [{ path: "README.md" }, { path: "skills/caveman/SKILL.md" }, { path: "skills/caveman/run.sh" }, { path: "skills/caveman/notes.md" }],
    { "skills/caveman/SKILL.md": "---\nname: caveman\n---\nTalk short." },
  );
  const result = await lookUpSkill(parseGithubUrl("o/r"), fetch);
  assert.equal(result.kind, "preview");
  if (result.kind !== "preview") return;
  assert.equal(result.preview.sha, SHA);
  assert.equal(result.preview.name, "caveman");
  assert.equal(result.preview.path, "skills/caveman");
  assert.match(result.preview.text, /Talk short/);
  assert.deepEqual(result.preview.files.map((f) => f.path).sort(), ["SKILL.md", "notes.md", "run.sh"]);
  assert.deepEqual(result.preview.risky, ["run.sh"]);
});

test("a repo with several skills lists them to choose from", async () => {
  const { fetch } = fakeGithub(
    [{ path: "a/SKILL.md" }, { path: "b/SKILL.md" }, { path: "b/more/SKILL.md" }],
    { "b/SKILL.md": "B", "b/more/SKILL.md": "M", "a/SKILL.md": "A" },
  );
  const result = await lookUpSkill(parseGithubUrl("o/r"), fetch);
  assert.equal(result.kind, "choose");
  if (result.kind !== "choose") return;
  assert.deepEqual(result.candidates.map((c) => c.path), ["a", "b", "b/more"]);
  const picked = await previewPicked("o/r", result.sha, "b", fetch);
  assert.equal(picked.text, "B");
  assert.deepEqual(picked.files.map((f) => f.path).sort(), ["SKILL.md", "more/SKILL.md"]);
  await assert.rejects(previewPicked("o/r", result.sha, "../b", fetch), /Unsafe path/);
});

test("says so when there is no SKILL.md, the repo is too big, or a skill is too big", async () => {
  await assert.rejects(lookUpSkill(parseGithubUrl("o/r"), fakeGithub([{ path: "README.md" }], {}).fetch), /No SKILL\.md/);
  await assert.rejects(lookUpSkill(parseGithubUrl("o/r"), fakeGithub([], {}, { truncated: true }).fetch), /too large/);
  const huge = [{ path: "s/SKILL.md", size: 600_000 }, { path: "s/big.md", size: 600_000 }];
  await assert.rejects(lookUpSkill(parseGithubUrl("o/r"), fakeGithub(huge, { "s/SKILL.md": "x" }).fetch), /more than the 1000 KB/);
  const many = Array.from({ length: 101 }, (_, i) => ({ path: `s/f${i}.md` })).concat([{ path: "s/SKILL.md" }]);
  await assert.rejects(lookUpSkill(parseGithubUrl("o/r"), fakeGithub(many, { "s/SKILL.md": "x" }).fetch), /more than the 100/);
});

test("symlinks in a skill are left out", async () => {
  const { fetch } = fakeGithub([{ path: "s/SKILL.md" }, { path: "s/link.md", mode: "120000" }, { path: "s/dir", type: "tree" }], { "s/SKILL.md": "x" });
  const result = await lookUpSkill(parseGithubUrl("o/r"), fetch);
  assert.equal(result.kind === "preview" && result.preview.files.length, 1);
});

test("a repo that can't be found, or rate limiting, gives a plain message", async () => {
  const notFound: Fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) });
  const limited: Fetch = async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) });
  await assert.rejects(lookUpSkill(parseGithubUrl("o/r"), notFound), /must be public/);
  await assert.rejects(lookUpSkill(parseGithubUrl("o/r"), limited), /limiting requests/);
});

async function previewOf(entries: Entry[], contents: Record<string, string>) {
  const github = fakeGithub(entries, contents);
  const result = await lookUpSkill(parseGithubUrl("o/r"), github.fetch);
  if (result.kind !== "preview") throw new Error("expected a preview");
  return { preview: result.preview, fetch: github.fetch };
}

test("installs the previewed files into .claude/skills and records the commit", async () => {
  const { preview, fetch } = await previewOf(
    [{ path: "skills/caveman/SKILL.md" }, { path: "skills/caveman/refs/more.md" }],
    { "skills/caveman/SKILL.md": "Talk short.", "skills/caveman/refs/more.md": "More." },
  );
  await installSkill(dir, preview, fetch);
  assert.equal(readFileSync(join(dir, ".claude/skills/caveman/SKILL.md"), "utf8"), "Talk short.");
  assert.equal(readFileSync(join(dir, ".claude/skills/caveman/refs/more.md"), "utf8"), "More.");
  assert.deepEqual(installedSkill(dir, "caveman"), { repo: "o/r", path: "skills/caveman", sha: SHA });
  assert.equal(installedSkill(dir, "other"), null);
});

test("installing again replaces Hacky's own copy, and removing deletes it", async () => {
  const { preview, fetch } = await previewOf([{ path: "s/SKILL.md" }], { "s/SKILL.md": "v1" });
  await installSkill(dir, preview, fetch);
  writeFileSync(join(dir, ".claude/skills/s/stale.md"), "old");
  await installSkill(dir, preview, fetch);
  assert.equal(existsSync(join(dir, ".claude/skills/s/stale.md")), false);
  removeSkill(dir, "s");
  assert.equal(existsSync(join(dir, ".claude/skills/s")), false);
});

test("never overwrites or deletes a skill the person wrote themselves", async () => {
  mkdirSync(join(dir, ".claude/skills/s"), { recursive: true });
  writeFileSync(join(dir, ".claude/skills/s/SKILL.md"), "mine");
  const { preview, fetch } = await previewOf([{ path: "s/SKILL.md" }], { "s/SKILL.md": "theirs" });
  await assert.rejects(installSkill(dir, preview, fetch), /already exists and wasn't installed by Hacky/);
  assert.equal(installedSkill(dir, "s"), "manual");
  removeSkill(dir, "s");
  assert.equal(readFileSync(join(dir, ".claude/skills/s/SKILL.md"), "utf8"), "mine");
});

test("a failed download leaves the earlier copy untouched", async () => {
  const { preview, fetch } = await previewOf([{ path: "s/SKILL.md" }], { "s/SKILL.md": "v1" });
  await installSkill(dir, preview, fetch);
  const broken: Fetch = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) });
  await assert.rejects(installSkill(dir, preview, broken), /Couldn't download/);
  assert.equal(readFileSync(join(dir, ".claude/skills/s/SKILL.md"), "utf8"), "v1");
});

test("a preview with a path that climbs out is refused at install time too", async () => {
  const { preview, fetch } = await previewOf([{ path: "s/SKILL.md" }], { "s/SKILL.md": "x" });
  const evil = { ...preview, files: [...preview.files, { path: "../../escape.txt", size: 1 }] };
  await assert.rejects(installSkill(dir, evil, fetch), /Unsafe path/);
  assert.equal(existsSync(join(dir, ".claude/skills/s")), false, "nothing was written");
  await assert.rejects(installSkill(dir, { ...preview, name: ".." }, fetch), /Unsafe skill name/);
});
