// GitHub link and the same-project check, with no VS Code dependency.
//
// - A group links one GitHub repository. The app reads it through GitHub's REST API, with the
//   person's own token when they saved one (kept in a local file, never sent to Hacky's database).
// - Every person's active folder is described by a fingerprint: the repository's first commit and
//   its remote. Two folders with the same first commit or the same remote are the same project, so
//   the check works even for groups that haven't linked GitHub.
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

const TIMEOUT_MS = 10_000;
const LIST_LIMIT = 10;
const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
// owner/name, where neither part is "." or "..", so it can't climb out of /repos/ in an API URL.
const isRepoName = (text: string) => REPO_PATTERN.test(text) && text.split("/").every((part) => part !== "." && part !== "..");

export type GithubFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; headers?: { get(name: string): string | null }; json(): Promise<any> }>;

// ---- Repository names and remotes ----

// "owner/name" from what a person types or pastes: owner/name, a github.com link, or a clone URL.
export function parseRepo(input: string): string {
  let text = input.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  const ssh = /^git@github\.com:(.+)$/i.exec(text);
  if (ssh) text = ssh[1];
  else if (/^(https?|ssh|git):\/\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new Error("That isn't a valid link.");
    }
    if (url.hostname.toLowerCase() !== "github.com" && url.hostname.toLowerCase() !== "www.github.com") throw new Error("Only github.com repositories can be linked.");
    text = url.pathname.split("/").filter(Boolean).slice(0, 2).join("/").replace(/\.git$/i, "");
  } else if (/^(www\.)?github\.com\//i.test(text)) {
    text = text.replace(/^(www\.)?github\.com\//i, "").split("/").slice(0, 2).join("/");
  }
  if (!isRepoName(text)) {
    throw new Error("Give the repository as owner/name or as its github.com link.");
  }
  return text;
}

// A remote URL in a form that is the same for every clone of a repository: host/path, lowercase,
// without credentials, port, protocol or ".git". Null for remotes that are local folders.
export function normalizeRemote(url: string): string | null {
  const text = url.trim();
  if (!text) return null;
  let host: string;
  let path: string;
  const scp = /^(?:[^@\s/]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(text);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let parsed: URL;
    try {
      parsed = new URL(text);
    } catch {
      return null;
    }
    if (parsed.protocol === "file:") return null;
    host = parsed.hostname;
    path = parsed.pathname;
  } else if (scp && !/^[a-z]:$/i.test(`${scp[1]}:`)) {
    // user@host:path, as ssh writes it. A Windows drive (C:\...) is a local folder.
    host = scp[1];
    path = scp[2];
  } else {
    return null;
  }
  const clean = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (!host || !clean) return null;
  return `${host.toLowerCase().replace(/^www\./, "")}/${clean.toLowerCase()}`.slice(0, 300);
}

// The owner/name of a normalized remote when it is on GitHub.
export function githubRepoOf(remote: string | null): string | null {
  if (!remote?.startsWith("github.com/")) return null;
  const rest = remote.slice("github.com/".length);
  return isRepoName(rest) ? rest : null;
}

// ---- Fingerprint of a folder ----

export type Fingerprint = { folderName: string; rootCommit: string | null; remote: string | null };
export type Run = (args: string[], cwd: string) => Promise<string>;

const runGit: Run = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: TIMEOUT_MS, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });

// What project a folder is. Folders that aren't git repositories, or git isn't installed, give only the name.
export async function readFingerprint(dir: string, run: Run = runGit): Promise<Fingerprint> {
  const fingerprint: Fingerprint = { folderName: basename(dir).slice(0, 200) || dir.slice(0, 200), rootCommit: null, remote: null };
  try {
    // A shallow clone's oldest commit is wherever the clone stopped, not the real first commit.
    const shallow = (await run(["rev-parse", "--is-shallow-repository"], dir)).trim() === "true";
    if (!shallow) {
      const roots = (await run(["rev-list", "--max-parents=0", "HEAD"], dir)).split(/\s+/).filter((line) => /^[0-9a-f]{40}$/.test(line));
      fingerprint.rootCommit = roots.sort()[0] ?? null;
    }
  } catch {
    // Not a repository, no commits yet, or no git.
  }
  try {
    const remotes = (await run(["remote"], dir)).split(/\s+/).filter(Boolean);
    const name = remotes.includes("origin") ? "origin" : remotes[0];
    if (name) fingerprint.remote = normalizeRemote(await run(["remote", "get-url", name], dir));
  } catch {
    // No remote.
  }
  return fingerprint;
}

// ---- The check ----

export type MemberFingerprint = Fingerprint & { userId: string; name: string; me: boolean; updatedAt: string };
export type ProjectVerdict = "same" | "different" | "unknown" | "missing";
export type ProjectCheckRow = {
  userId: string;
  name: string;
  me: boolean;
  verdict: ProjectVerdict;
  // Why, in one short sentence for the screen.
  reason: string;
  folderName: string | null;
  remote: string | null;
  updatedAt: string | null;
};
export type ProjectCheck = {
  // ok: everyone who reported is in the same project. mismatch: at least one isn't. unclear: not enough to tell.
  status: "ok" | "mismatch" | "unclear";
  basis: "github" | "git" | "none";
  rows: ProjectCheckRow[];
};

const sameRepo = (a: string | null, b: string | null) => a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

// Compares everyone's folder with the linked repository, or, without one, with each other.
export function compareProjects(members: { userId: string; name: string; me: boolean }[], prints: MemberFingerprint[], linkedRepo: string | null): ProjectCheck {
  const byUser = new Map(prints.map((print) => [print.userId, print]));
  const reported = members.map((member) => byUser.get(member.userId)).filter((print): print is MemberFingerprint => Boolean(print));
  const verdicts = new Map<string, { verdict: ProjectVerdict; reason: string }>();

  if (linkedRepo) {
    // Folders whose remote is the linked repository, and the first commits they share.
    const linkedRoots = new Set(reported.filter((print) => sameRepo(githubRepoOf(print.remote), linkedRepo) && print.rootCommit).map((print) => print.rootCommit));
    for (const print of reported) {
      const repo = githubRepoOf(print.remote);
      if (sameRepo(repo, linkedRepo)) verdicts.set(print.userId, { verdict: "same", reason: `Folder ${print.folderName} pushes to ${linkedRepo}.` });
      else if (print.rootCommit && linkedRoots.has(print.rootCommit)) verdicts.set(print.userId, { verdict: "same", reason: `Folder ${print.folderName} has the same history as ${linkedRepo}.` });
      else if (print.remote) verdicts.set(print.userId, { verdict: "different", reason: `Folder ${print.folderName} pushes to ${repo ?? print.remote}, not ${linkedRepo}.` });
      else if (print.rootCommit) verdicts.set(print.userId, { verdict: "unknown", reason: `Folder ${print.folderName} has no remote, and nobody's copy of ${linkedRepo} shares its history yet.` });
      else verdicts.set(print.userId, { verdict: "unknown", reason: `Folder ${print.folderName} isn't a git repository, so it can't be compared with ${linkedRepo}.` });
    }
  } else {
    // Folders are one project when they share a first commit or a remote, also through someone else.
    const parent = new Map(reported.map((print) => [print.userId, print.userId]));
    const find = (id: string): string => {
      const up = parent.get(id)!;
      if (up === id) return id;
      const top = find(up);
      parent.set(id, top);
      return top;
    };
    const comparable = reported.filter((print) => print.rootCommit || print.remote);
    for (let i = 0; i < comparable.length; i++) {
      for (let j = i + 1; j < comparable.length; j++) {
        const a = comparable[i];
        const b = comparable[j];
        if ((a.rootCommit && a.rootCommit === b.rootCommit) || (a.remote && a.remote === b.remote)) parent.set(find(a.userId), find(b.userId));
      }
    }
    const groups = new Map<string, MemberFingerprint[]>();
    for (const print of comparable) groups.set(find(print.userId), [...(groups.get(find(print.userId)) ?? []), print]);
    // The project is the one most people are in. On a tie, the signed-in person's.
    const main = [...groups.values()].sort((a, b) => b.length - a.length || Number(b.some((print) => print.me)) - Number(a.some((print) => print.me)))[0] ?? [];
    const mainIds = new Set(main.map((print) => print.userId));
    const mainNames = new Set(main.map((print) => print.folderName.toLowerCase()));
    const mainLabel = main[0] ? (main[0].remote ?? `folder ${main[0].folderName}`) : "";
    for (const print of reported) {
      if (mainIds.has(print.userId)) {
        verdicts.set(print.userId, { verdict: "same", reason: main.length > 1 ? `Same history as the others in ${mainLabel}.` : `Folder ${print.folderName}. Nobody else has reported a git folder yet.` });
      } else if (print.rootCommit || print.remote) {
        verdicts.set(print.userId, { verdict: "different", reason: `Folder ${print.folderName} has a different history from ${mainLabel}.` });
      } else {
        const named = main.length > 0 && mainNames.has(print.folderName.toLowerCase());
        verdicts.set(print.userId, {
          verdict: "unknown",
          reason: named ? `Folder ${print.folderName} isn't a git repository. Its name matches, but that alone doesn't prove it's the same project.` : `Folder ${print.folderName} isn't a git repository, so it can't be compared.`,
        });
      }
    }
  }

  const rows: ProjectCheckRow[] = members.map((member) => {
    const print = byUser.get(member.userId);
    const verdict = verdicts.get(member.userId) ?? { verdict: "missing" as const, reason: "Hasn't opened Hacky with a project folder yet." };
    return { ...member, ...verdict, folderName: print?.folderName ?? null, remote: print?.remote ?? null, updatedAt: print?.updatedAt ?? null };
  });
  const status = rows.some((row) => row.verdict === "different") ? "mismatch" : rows.filter((row) => row.verdict === "same").length >= 2 && !rows.some((row) => row.verdict === "unknown") ? "ok" : "unclear";
  const basis = linkedRepo ? "github" : reported.some((print) => print.rootCommit || print.remote) ? "git" : "none";
  return { status, basis, rows };
}

// ---- GitHub API ----

export type GithubRepoInfo = {
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  url: string;
  stars: number;
  openIssues: number;
  pushedAt: string | null;
};
export type GithubPull = { number: number; title: string; author: string; url: string; updatedAt: string; draft: boolean };
export type GithubCommit = { sha: string; message: string; author: string; url: string; date: string };
export type GithubOverview = { repo: GithubRepoInfo; pulls: GithubPull[]; commits: GithubCommit[] };

// Only https links to github.com are passed to the screen, which opens them.
const githubLink = (url: unknown) => (typeof url === "string" && url.startsWith("https://github.com/") ? url : "");

async function getJson(fetcher: GithubFetch, path: string, token: string | null): Promise<any> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "hacky-app", "X-GitHub-Api-Version": "2022-11-28" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetcher(`https://api.github.com${path}`, { headers });
  if (response.ok) return response.json();
  if (response.status === 401) throw new Error("GitHub no longer accepts your sign-in. Sign out and sign in again.");
  if (response.status === 404) throw new Error(token ? "GitHub can't find that repository, or your token can't see it." : "GitHub can't find that repository. If it's private, sign in with GitHub.");
  if (response.status === 403 || response.status === 429) {
    const remaining = response.headers?.get("x-ratelimit-remaining");
    throw new Error(remaining === "0" ? (token ? "GitHub's rate limit is used up. Try again in a while." : "GitHub's rate limit for apps without a token is used up. Save a token, or try again in a while.") : "GitHub refused the request.");
  }
  throw new Error(`GitHub answered with an error (${response.status}).`);
}

export async function fetchGithubOverview(repo: string, token: string | null, fetcher: GithubFetch): Promise<GithubOverview> {
  if (!isRepoName(repo)) throw new Error("That isn't a repository name.");
  const info = await getJson(fetcher, `/repos/${repo}`, token);
  const [pulls, commits] = await Promise.all([
    getJson(fetcher, `/repos/${repo}/pulls?state=open&per_page=${LIST_LIMIT}`, token),
    getJson(fetcher, `/repos/${repo}/commits?per_page=${LIST_LIMIT}`, token).catch(() => []),
  ]);
  return {
    repo: {
      fullName: String(info.full_name ?? repo),
      description: typeof info.description === "string" ? info.description : null,
      private: Boolean(info.private),
      defaultBranch: String(info.default_branch ?? "main"),
      url: githubLink(info.html_url),
      stars: Number(info.stargazers_count ?? 0),
      openIssues: Number(info.open_issues_count ?? 0),
      pushedAt: typeof info.pushed_at === "string" ? info.pushed_at : null,
    },
    pulls: (Array.isArray(pulls) ? pulls : []).slice(0, LIST_LIMIT).map((pull: any) => ({
      number: Number(pull.number),
      title: String(pull.title ?? ""),
      author: String(pull.user?.login ?? "someone"),
      url: githubLink(pull.html_url),
      updatedAt: String(pull.updated_at ?? ""),
      draft: Boolean(pull.draft),
    })),
    commits: (Array.isArray(commits) ? commits : []).slice(0, LIST_LIMIT).map((commit: any) => ({
      sha: String(commit.sha ?? "").slice(0, 7),
      message: String(commit.commit?.message ?? "").split("\n")[0],
      author: String(commit.author?.login ?? commit.commit?.author?.name ?? "someone"),
      url: githubLink(commit.html_url),
      date: String(commit.commit?.author?.date ?? ""),
    })),
  };
}

// Who a token belongs to, to check it before saving.
export async function githubLogin(token: string, fetcher: GithubFetch): Promise<string> {
  const user = await getJson(fetcher, "/user", token);
  return String(user.login ?? "");
}

// The person's own repositories, most recently pushed first, so a lead can pick one to link.
export type GithubRepoChoice = { fullName: string; private: boolean; pushedAt: string | null };
export async function fetchMyRepos(token: string, fetcher: GithubFetch): Promise<GithubRepoChoice[]> {
  const rows = await getJson(fetcher, "/user/repos?sort=pushed&per_page=50&affiliation=owner,collaborator,organization_member", token);
  return (Array.isArray(rows) ? rows : [])
    .map((row: any) => ({ fullName: String(row.full_name ?? ""), private: Boolean(row.private), pushedAt: typeof row.pushed_at === "string" ? row.pushed_at : null }))
    .filter((row) => isRepoName(row.fullName));
}

// ---- Sign in with GitHub: the OAuth device flow ----
// The app shows a short code, the person enters it at github.com/login/device, and the app asks
// GitHub every few seconds whether they approved. It needs only the OAuth App's client ID, which
// isn't secret, so nothing secret ships in the app.

// "repo" lets the app read private repositories the person can see. "read:user" names the account.
export const GITHUB_SCOPES = "repo read:user";
export type DeviceCode = { deviceCode: string; userCode: string; verificationUri: string; intervalSeconds: number; expiresAt: number };
export type DevicePoll = { kind: "token"; token: string } | { kind: "pending" } | { kind: "slow_down"; intervalSeconds: number } | { kind: "error"; message: string };

async function postForm(fetcher: GithubFetch, url: string, form: Record<string, string>): Promise<any> {
  const response = await fetcher(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "hacky-app" },
    body: new URLSearchParams(form).toString(),
  });
  if (!response.ok) throw new Error(`GitHub answered with an error (${response.status}).`);
  return response.json();
}

export async function startDeviceFlow(clientId: string, fetcher: GithubFetch, now = Date.now()): Promise<DeviceCode> {
  const body = await postForm(fetcher, "https://github.com/login/device/code", { client_id: clientId, scope: GITHUB_SCOPES });
  if (body.error) throw new Error(body.error === "device_flow_disabled" ? "Device sign-in is turned off for Hacky's GitHub app. Turn on Enable Device Flow in its settings." : `GitHub refused to start sign-in (${body.error}).`);
  const verificationUri = String(body.verification_uri ?? "");
  if (!body.device_code || !body.user_code || !verificationUri.startsWith("https://github.com/")) throw new Error("GitHub sent an unexpected answer.");
  return {
    deviceCode: String(body.device_code),
    userCode: String(body.user_code),
    verificationUri,
    intervalSeconds: Math.max(5, Number(body.interval) || 5),
    expiresAt: now + (Number(body.expires_in) || 900) * 1000,
  };
}

export async function pollDeviceFlow(clientId: string, deviceCode: string, fetcher: GithubFetch): Promise<DevicePoll> {
  const body = await postForm(fetcher, "https://github.com/login/oauth/access_token", {
    client_id: clientId,
    device_code: deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  if (typeof body.access_token === "string" && body.access_token) return { kind: "token", token: body.access_token };
  switch (body.error) {
    case "authorization_pending":
      return { kind: "pending" };
    case "slow_down":
      return { kind: "slow_down", intervalSeconds: Math.max(5, Number(body.interval) || 10) };
    case "expired_token":
      return { kind: "error", message: "The sign-in code expired. Start again." };
    case "access_denied":
      return { kind: "error", message: "Sign-in was cancelled on GitHub." };
    default:
      return { kind: "error", message: `GitHub sign-in failed (${body.error ?? "no answer"}).` };
  }
}

// ---- The person's GitHub account, on their own computer only ----
// via: "signin" when the person signed in with GitHub, "token" when they pasted a token.
export type GithubAccount = { token: string; login: string; via: "signin" | "token" };

export function readAccount(file: string): GithubAccount | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.token === "string" && parsed.token) {
      return { token: parsed.token, login: typeof parsed.login === "string" ? parsed.login : "", via: parsed.via === "signin" ? "signin" : "token" };
    }
    return null;
  } catch {
    // An older version saved the bare token.
    return { token: text, login: "", via: "token" };
  }
}

export function readToken(file: string): string | null {
  return readAccount(file)?.token ?? null;
}

export function writeAccount(file: string, account: GithubAccount): void {
  writeToken(file, JSON.stringify(account));
}

export function writeToken(file: string, token: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, token, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows keeps the file in the person's own profile folder.
  }
}

export function deleteToken(file: string): void {
  if (existsSync(file)) rmSync(file);
}

// A token as GitHub issues them: classic (ghp_), fine-grained (github_pat_) or OAuth (gho_).
export function checkTokenShape(token: string): string {
  const clean = token.trim();
  if (!/^(ghp_|github_pat_|gho_|ghu_)[A-Za-z0-9_]{20,255}$/.test(clean)) throw new Error("That doesn't look like a GitHub token. It starts with github_pat_ or ghp_.");
  return clean;
}
