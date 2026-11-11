// Reads a folder's git history for the Git screen: branches, and commits laid out in lanes so the
// screen can draw the graph. Read-only: it only ever runs git commands that look, and never
// through a shell.
import { execFile } from "node:child_process";
import { basename } from "node:path";

const MAX_COMMITS = 300;
const MAX_BUFFER = 16 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

export type GitEdge = { parent: string; slot: number };
export type GitCommit = {
  hash: string;
  short: string;
  parents: string[];
  author: string;
  time: number;
  subject: string;
  // Branch and tag names pointing here, e.g. "main", "origin/main", "tag: v1". "HEAD" marks the checked-out commit.
  refs: string[];
  lane: number;
  // One line to each parent, through the lane (slot) it travels in.
  edges: GitEdge[];
};
export type GitBranch = {
  name: string;
  remote: boolean;
  tip: string;
  current: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  gone: boolean;
  time: number;
};
export type GitGraph = { repo: string; commits: GitCommit[]; lanes: number; branches: GitBranch[]; head: string | null; detached: boolean; capped: boolean };

export type Run = (args: string[], cwd: string) => Promise<string>;

const run: Run = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return reject(new Error("Git isn't installed, or isn't on your PATH."));
      if (/not a git repository/i.test(stderr)) return reject(new Error("This folder isn't a git repository."));
      reject(new Error(stderr.trim().split("\n")[0] || error.message));
    });
  });

type RawCommit = Omit<GitCommit, "lane" | "edges">;

export function parseLog(text: string): RawCommit[] {
  return text
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter(Boolean)
    .map((record) => {
      const [hash, parents, author, time, refs, subject] = record.split("\x1f");
      return {
        hash,
        short: hash.slice(0, 7),
        parents: parents ? parents.split(" ") : [],
        author,
        time: Number(time),
        subject: subject ?? "",
        refs: refs ? refs.split(", ").map((ref) => ref.replace(/^HEAD -> /, "")).concat(refs.includes("HEAD -> ") ? ["HEAD"] : []) : [],
      };
    });
}

// Gives each commit a lane and each line to a parent a slot. A commit's first parent carries on in
// its own lane, so a branch stays a straight line; merges bring in extra lines from other lanes.
// Commits must come newest first with children before parents, which `git log --topo-order` gives.
export function layout(commits: RawCommit[]): { commits: GitCommit[]; lanes: number } {
  const active: (string | null)[] = [];
  const free = () => {
    const open = active.indexOf(null);
    return open === -1 ? active.length : open;
  };
  let lanes = 0;
  const placed = commits.map((commit) => {
    let lane = active.indexOf(commit.hash);
    if (lane === -1) lane = free();
    // Every other lane waiting for this commit ends here.
    for (let i = 0; i < active.length; i++) if (active[i] === commit.hash) active[i] = null;
    active[lane] = null;
    const edges = commit.parents.map((parent, index) => {
      // The first parent always carries on in this lane, even if another line already leads to it,
      // so the main line stays straight and the other lines bend in. Later parents join an
      // existing line to that commit if there is one.
      let slot = index === 0 ? lane : active.indexOf(parent);
      if (slot === -1) slot = free();
      active[slot] = parent;
      return { parent, slot };
    });
    lanes = Math.max(lanes, lane + 1, ...edges.map((edge) => edge.slot + 1));
    return { ...commit, lane, edges };
  });
  return { commits: placed, lanes };
}

function parseBranches(text: string): GitBranch[] {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [refname, name, tip, upstream, track, time, head] = line.split("\x1f");
      return {
        refname,
        branch: {
          name,
          remote: refname.startsWith("refs/remotes/"),
          tip,
          current: head === "*",
          upstream: upstream || null,
          ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
          behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
          gone: track.includes("gone"),
          time: Number(time),
        },
      };
    })
    .filter(({ refname }) => !refname.endsWith("/HEAD"))
    .map(({ branch }) => branch);
}

export async function readGit(dir: string, git: Run = run): Promise<GitGraph> {
  // allSettled, so a failure doesn't return while the other git commands are still running.
  const results = await Promise.allSettled([
    git(["for-each-ref", "--format=%(refname)%1f%(refname:short)%1f%(objectname)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(committerdate:unix)%1f%(HEAD)", "refs/heads", "refs/remotes"], dir),
    // --branches/--remotes/--tags rather than --all, so stashes and notes don't clutter the graph.
    git(["log", "--branches", "--remotes", "--tags", "HEAD", "--topo-order", `--max-count=${MAX_COMMITS + 1}`, "--format=%H%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s%x1e"], dir).catch((error: Error) => {
      // A repo with no commits yet has no HEAD to log.
      if (/does not have any commits|unknown revision|bad revision|ambiguous argument/i.test(error.message)) return "";
      throw error;
    }),
    git(["rev-parse", "--abbrev-ref", "HEAD"], dir).catch(() => ""),
  ]);
  const failed = results.find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
  if (failed) throw failed.reason;
  const [branchText, logText, headText] = results.map((result) => (result as PromiseFulfilledResult<string>).value);
  const raw = parseLog(logText);
  const capped = raw.length > MAX_COMMITS;
  const { commits, lanes } = layout(raw.slice(0, MAX_COMMITS));
  const headName = headText.trim();
  return {
    repo: basename(dir),
    commits,
    lanes,
    branches: parseBranches(branchText).sort((a, b) => Number(b.current) - Number(a.current) || Number(a.remote) - Number(b.remote) || b.time - a.time),
    head: headName && headName !== "HEAD" ? headName : null,
    detached: headName === "HEAD",
    capped,
  };
}
