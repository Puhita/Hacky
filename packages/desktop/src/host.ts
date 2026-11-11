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
]);

export type Tab = "board" | "map";
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
  if (message.type === "showTab") return message.tab === "board" || message.tab === "map" ? { kind: "showTab", tab: message.tab } : null;
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

export type PageName = "sidebar" | "board" | "map" | "tabs";
export const PAGE_NAMES: readonly PageName[] = ["sidebar", "board", "map", "tabs"];

// The strict policy the extension uses: only the app's own scripts and styles run.
export function pageHtml(name: PageName): string {
  const styles = name === "tabs" ? ["static/theme.css", "static/tabs.css"] : ["static/theme.css", `media/${name}.css`];
  const script = name === "tabs" ? "static/tabs.js" : `media/${name}.js`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; script-src 'self';">
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
