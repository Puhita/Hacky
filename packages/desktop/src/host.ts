// Decisions the app makes about messages and pages, kept apart from Electron so they can be tested.
import type { Message } from "../../extension/src/controller.js";

const CONTROLLER_TYPES: ReadonlySet<string> = new Set<Message["type"]>([
  "ready",
  "signIn",
  "signUp",
  "signOut",
  "createTeam",
  "joinTeam",
  "selectTeam",
  "connectWorkspace",
  "answer",
  "confirmAssumption",
  "rejectAssumption",
  "changeDecision",
  "withdrawDecision",
  "addTask",
  "answerTeammate",
  "openMap",
  "openBoard",
  "openSkills",
  "openGit",
  "loadGit",
  "previewSkill",
  "pickSkill",
  "previewTeamSkill",
  "installSkill",
  "cancelSkill",
  "unshareSkill",
  "removeLocalSkill",
]);

export type Tab = "board" | "map" | "skills" | "git" | "terminal";
const TABS: readonly string[] = ["board", "map", "skills", "git", "terminal"];
export type Parsed =
  | { kind: "controller"; message: Message }
  | { kind: "showTab"; tab: Tab }
  | { kind: "chooseFolder" }
  | { kind: "connectFolder"; path: string; editors: unknown }
  | { kind: "removeFolder"; path: string };

// A screen can only send what the sidebar controller or the app itself understands.
export function parseMessage(raw: unknown): Parsed | null {
  if (typeof raw !== "object" || raw === null) return null;
  const message = raw as { type?: unknown; tab?: unknown; path?: unknown; editors?: unknown };
  if (typeof message.type !== "string") return null;
  if (message.type === "chooseFolder") return { kind: "chooseFolder" };
  if (message.type === "connectFolder") return typeof message.path === "string" ? { kind: "connectFolder", path: message.path, editors: message.editors } : null;
  if (message.type === "removeFolder") return typeof message.path === "string" ? { kind: "removeFolder", path: message.path } : null;
  if (message.type === "showTab") return typeof message.tab === "string" && TABS.includes(message.tab) ? { kind: "showTab", tab: message.tab as Tab } : null;
  return CONTROLLER_TYPES.has(message.type) ? { kind: "controller", message: raw as Message } : null;
}

// The project folders the person has connected, newest last. A screen can only act on a folder
// that is in this list, so it can't make the app write somewhere else.
export function addFolder(folders: readonly string[], path: string): string[] {
  return folders.includes(path) ? [...folders] : [...folders, path];
}

export function removeFolder(folders: readonly string[], path: string): string[] {
  return folders.filter((folder) => folder !== path);
}

export type PageName = "sidebar" | "board" | "map" | "skills" | "git" | "terminal" | "tabs";
export const PAGE_NAMES: readonly PageName[] = ["sidebar", "board", "map", "skills", "git", "terminal", "tabs"];

// The strict policy the extension uses: only the app's own scripts and styles run.
export function pageHtml(name: PageName): string {
  // The tab bar and the terminal are the app's own; the rest are the extension's screens.
  const own = name === "tabs" || name === "terminal";
  const styles = name === "tabs" ? ["static/theme.css", "static/tabs.css"] : name === "terminal" ? ["static/theme.css", "static/xterm.css", "static/terminal.css"] : ["static/theme.css", `media/${name}.css`];
  // xterm.js sizes and colours its cells with inline styles. Scripts stay locked to the app's own files,
  // and the terminal draws only what a program prints, never HTML.
  const styleSrc = name === "terminal" ? "'self' 'unsafe-inline'" : "'self'";
  const script = own ? `static/${name}.js` : `media/${name}.js`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${styleSrc}; script-src 'self';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${styles.map((href) => `<link href="app://ui/${href}" rel="stylesheet">`).join("\n")}
</head>
<body>
<div id="root"></div>
${name === "tabs" ? '<div id="bar"></div>' : ""}<script src="app://ui/${script}"></script>
</body>
</html>`;
}

const FILE_PATTERN = /^(media|static)\/[a-z-]+\.(js|css)$/;

// Which file under dist/ an app://ui/ request may read, or null. Only the copied screens and
// stylesheets are reachable: no path can climb out of them.
export function assetPath(pathname: string): string | null {
  const path = pathname.replace(/^\/+/, "");
  return FILE_PATTERN.test(path) ? path : null;
}

export const contentType = (path: string) => (path.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8");

// ---- Terminals ----
// The terminal screen is the only one that may start a process, and only one of these three, in a
// folder the person has already added. It can't send a command line of its own.
export const TERMINAL_KINDS = ["claude", "codex", "shell"] as const;
export type TerminalKind = (typeof TERMINAL_KINDS)[number];
export const MAX_TERMINALS = 6;

// What is typed into the new shell to start the tool. Typing it, rather than starting the tool
// directly, lets Windows find it the way it does in the person's own terminal, and leaves them in a
// shell when it exits.
export const TERMINAL_COMMAND: Record<TerminalKind, string | null> = { claude: "claude", codex: "codex", shell: null };

export function parseTerminalOpen(raw: unknown, folders: readonly string[]): { kind: TerminalKind; folder: string } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { kind, folder } = raw as { kind?: unknown; folder?: unknown };
  if (typeof kind !== "string" || !(TERMINAL_KINDS as readonly string[]).includes(kind)) return null;
  if (typeof folder !== "string" || !folders.includes(folder)) return null;
  return { kind: kind as TerminalKind, folder };
}

// The environment a terminal starts with: the person's own, without the settings that make
// Electron behave as plain Node inside it.
export function terminalEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key.startsWith("ELECTRON_") || key === "HACKY_SMOKE_DIR") continue;
    clean[key] = value;
  }
  return clean;
}
