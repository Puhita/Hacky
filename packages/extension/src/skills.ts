// Agent skills from GitHub: a folder holding a SKILL.md, which Claude Code reads from
// .claude/skills/<name>/. A skill is looked up at one exact commit, shown to the person first, and
// only then copied. Nothing in it is ever run. Everything here is a plain function over an
// injectable fetch, so it can be tested without the network.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>;

export const SKILL_MARKER = ".hacky-skill.json";
const MAX_FILES = 100;
const MAX_BYTES = 1_000_000;
const MAX_CANDIDATES = 50;
const MAX_PREVIEW_CHARS = 20_000;
const SKILL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// Anything that isn't plain documentation is worth a second look before it is copied.
const TEXT_FILE = /\.(md|mdx|txt|json|ya?ml|toml|csv)$/i;

export type SkillSource = { repo: string; ref: string | null; path: string };
export type SkillFile = { path: string; size: number };
export type SkillCandidate = { name: string; path: string };
export type SkillPreview = {
  repo: string;
  path: string;
  sha: string;
  name: string;
  text: string;
  truncated: boolean;
  files: SkillFile[];
  // Files that aren't plain text, shown as a warning.
  risky: string[];
};
export type SkillLookup = { kind: "choose"; repo: string; sha: string; candidates: SkillCandidate[] } | { kind: "preview"; preview: SkillPreview };

// "owner/repo", or a github.com link to a repo or to a folder inside one. A branch name with a slash
// can't be told from a folder, so the first part after /tree/ is taken as the branch.
export function parseGithubUrl(input: string): SkillSource {
  const text = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  let parts: string[];
  if (/^https?:\/\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new Error("That isn't a valid link.");
    }
    if (url.protocol !== "https:" || url.hostname !== "github.com") throw new Error("Only github.com links are supported.");
    parts = url.pathname.split("/").filter(Boolean);
  } else {
    parts = text.split("/").filter(Boolean);
  }
  const [owner, repo, kind, ref, ...path] = parts;
  if (!owner || !repo || !/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) {
    throw new Error("Paste a GitHub link like github.com/owner/repo or github.com/owner/repo/tree/main/skills/name.");
  }
  if (kind !== undefined && kind !== "tree" && kind !== "blob") throw new Error("Paste a link to a repo or to a folder in it.");
  const folder = path.join("/");
  // A link to the SKILL.md file itself means its folder.
  const cleaned = folder.replace(/(^|\/)SKILL\.md$/, "");
  assertSafePath(cleaned, true);
  return { repo: `${owner}/${repo}`, ref: ref ?? null, path: cleaned };
}

// A path inside a repo or a skill folder: no climbing, no drive letters, no empty parts.
export function assertSafePath(path: string, allowEmpty = false): void {
  if (path === "") {
    if (allowEmpty) return;
    throw new Error("Empty path.");
  }
  if (path.includes("\\") || path.includes(":") || path.includes("\0")) throw new Error(`Unsafe path: ${path}`);
  for (const part of path.split("/")) {
    if (part === "" || part === "." || part === "..") throw new Error(`Unsafe path: ${path}`);
  }
}

export function skillName(path: string, repo: string): string {
  const last = path ? path.split("/").pop()! : repo.split("/")[1];
  const name = last.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 64);
  if (!SKILL_NAME.test(name)) throw new Error(`"${last}" can't be used as a skill name.`);
  return name;
}

async function getJson(fetch: Fetch, url: string): Promise<any> {
  const response = await fetch(url);
  if (response.status === 403 || response.status === 429) throw new Error("GitHub is limiting requests right now. Try again in a few minutes.");
  if (response.status === 404) throw new Error("GitHub couldn't find that repo or folder. It must be public.");
  if (!response.ok) throw new Error(`GitHub answered ${response.status}.`);
  return response.json();
}

type TreeEntry = { path: string; type: string; mode: string; size?: number };

async function treeAt(fetch: Fetch, repo: string, ref: string | null): Promise<{ sha: string; tree: TreeEntry[] }> {
  const commit = await getJson(fetch, `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref ?? "HEAD")}`);
  const sha = String(commit.sha ?? "");
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("GitHub didn't return a commit.");
  const listing = await getJson(fetch, `https://api.github.com/repos/${repo}/git/trees/${sha}?recursive=1`);
  if (listing.truncated) throw new Error("That repo is too large to browse. Link to a folder in a smaller repo instead.");
  return { sha, tree: listing.tree as TreeEntry[] };
}

const underPath = (entry: string, path: string) => path === "" || entry === path || entry.startsWith(`${path}/`);

// Files of one skill folder at a commit. Symlinks and other odd entries are left out.
function filesOf(tree: TreeEntry[], path: string): SkillFile[] {
  const prefix = path === "" ? "" : `${path}/`;
  return tree
    .filter((entry) => entry.type === "blob" && entry.mode !== "120000" && entry.path.startsWith(prefix))
    .map((entry) => ({ path: entry.path.slice(prefix.length), size: entry.size ?? 0 }));
}

// Finds the skill a link points at. A link to a folder holding several skills returns the list to
// choose from; a link to one skill returns its preview.
export async function lookUpSkill(source: SkillSource, fetch: Fetch): Promise<SkillLookup> {
  const { sha, tree } = await treeAt(fetch, source.repo, source.ref);
  const skillDirs = tree
    .filter((entry) => entry.type === "blob" && /(^|\/)SKILL\.md$/.test(entry.path))
    .map((entry) => entry.path.replace(/\/?SKILL\.md$/, ""))
    .filter((dir) => underPath(dir, source.path) || source.path === dir);
  if (skillDirs.length === 0) throw new Error("No SKILL.md found there. A skill is a folder with a SKILL.md file in it.");
  if (skillDirs.includes(source.path)) return { kind: "preview", preview: await previewSkill(source.repo, sha, source.path, tree, fetch) };
  if (skillDirs.length === 1) return { kind: "preview", preview: await previewSkill(source.repo, sha, skillDirs[0], tree, fetch) };
  const candidates = skillDirs.slice(0, MAX_CANDIDATES).map((dir) => ({ name: skillName(dir, source.repo), path: dir }));
  return { kind: "choose", repo: source.repo, sha, candidates };
}

// A skill the person picked from a list, at the commit the list was made from.
export async function previewPicked(repo: string, sha: string, path: string, fetch: Fetch): Promise<SkillPreview> {
  assertSafePath(path, true);
  const listing = await getJson(fetch, `https://api.github.com/repos/${repo}/git/trees/${sha}?recursive=1`);
  return previewSkill(repo, sha, path, listing.tree as TreeEntry[], fetch);
}

async function previewSkill(repo: string, sha: string, path: string, tree: TreeEntry[], fetch: Fetch): Promise<SkillPreview> {
  const files = filesOf(tree, path);
  if (!files.some((file) => file.path === "SKILL.md")) throw new Error("No SKILL.md found there.");
  if (files.length > MAX_FILES) throw new Error(`That skill has ${files.length} files, more than the ${MAX_FILES} allowed.`);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_BYTES) throw new Error(`That skill is ${Math.round(total / 1024)} KB, more than the ${MAX_BYTES / 1000} KB allowed.`);
  for (const file of files) assertSafePath(file.path);
  const full = await rawText(fetch, repo, sha, path ? `${path}/SKILL.md` : "SKILL.md");
  return {
    repo,
    path,
    sha,
    name: skillName(path, repo),
    text: full.slice(0, MAX_PREVIEW_CHARS),
    truncated: full.length > MAX_PREVIEW_CHARS,
    files,
    risky: files.filter((file) => !TEXT_FILE.test(file.path)).map((file) => file.path),
  };
}

async function rawResponse(fetch: Fetch, repo: string, sha: string, path: string) {
  const response = await fetch(`https://raw.githubusercontent.com/${repo}/${sha}/${path.split("/").map(encodeURIComponent).join("/")}`);
  if (!response.ok) throw new Error(`Couldn't download ${path} (${response.status}).`);
  return response;
}

const rawText = async (fetch: Fetch, repo: string, sha: string, path: string) => (await rawResponse(fetch, repo, sha, path)).text();

export type InstalledSkill = { repo: string; path: string; sha: string };

// What a folder holds for one skill name: nothing, a skill Hacky installed, or someone's own files.
export function installedSkill(dir: string, name: string): InstalledSkill | "manual" | null {
  const target = join(dir, ".claude", "skills", name);
  if (!existsSync(target)) return null;
  try {
    const marker = JSON.parse(readFileSync(join(target, SKILL_MARKER), "utf8"));
    return { repo: marker.repo, path: marker.path, sha: marker.sha };
  } catch {
    return "manual";
  }
}

// Copies the previewed files into .claude/skills/<name>. It replaces a skill Hacky installed earlier
// and refuses to touch a folder of the person's own with the same name.
export async function installSkill(dir: string, preview: SkillPreview, fetch: Fetch): Promise<void> {
  const root = resolve(dir, ".claude", "skills");
  const target = resolve(root, preview.name);
  if (!target.startsWith(root + sep)) throw new Error("Unsafe skill name.");
  const existing = installedSkill(dir, preview.name);
  if (existing === "manual") throw new Error(`.claude/skills/${preview.name} already exists and wasn't installed by Hacky, so it was left alone.`);

  // Download everything before touching the folder, so a failure leaves the old copy intact.
  const downloaded: { relative: string; content: Buffer }[] = [];
  for (const file of preview.files) {
    assertSafePath(file.path);
    const full = preview.path ? `${preview.path}/${file.path}` : file.path;
    downloaded.push({ relative: file.path, content: Buffer.from(await (await rawResponse(fetch, preview.repo, preview.sha, full)).arrayBuffer()) });
  }
  if (existing) rmSync(target, { recursive: true, force: true });
  for (const { relative, content } of downloaded) {
    const destination = resolve(target, ...relative.split("/"));
    if (!destination.startsWith(target + sep)) throw new Error(`Unsafe path: ${relative}`);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
  writeFileSync(join(target, SKILL_MARKER), JSON.stringify({ repo: preview.repo, path: preview.path, sha: preview.sha }, null, 2) + "\n");
}

// Removes a skill Hacky installed. Someone's own folder is never deleted.
export function removeSkill(dir: string, name: string): void {
  if (!SKILL_NAME.test(name)) throw new Error("Unsafe skill name.");
  if (!installedSkill(dir, name) || installedSkill(dir, name) === "manual") return;
  rmSync(join(dir, ".claude", "skills", name), { recursive: true, force: true });
}
