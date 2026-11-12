// Connects a workspace to a team: registers the MCP server for Claude Code, Cursor or Codex and
// tells agents to use it. Existing content in these files is always preserved.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SERVER_NAME = "hacky";
const BLOCK_START = "<!-- hacky:start -->";
const BLOCK_END = "<!-- hacky:end -->";

export const MANAGED_BLOCK = `${BLOCK_START}
## Team coordination (Hacky)

You are one of several agents working for a team. The team shares tasks, progress and decisions through the Hacky tools.

- At the start of a session, call \`get_context\`. If it shows an answer, notice or teammate question ready, collect it with \`check_answers\`.
- Your person may run several chats. If \`get_context\` lists one of their other chats under \`my_other_chats\` that is idle or ended and has a focus, handoff or open waits, read it. If it is work you should continue, call \`resume_session\` and carry on from its notes. If it is \`active_now\`, leave it alone and don't duplicate its work.
- Before working on a task from the team board, call \`claim_task\`. If it says a teammate owns the task, leave it alone. Call \`complete_task\` when you finish one.
- When you finish a chunk of work, call \`log_progress\`, and at least every 15 minutes while you work. Pass \`next\` with what you'll do next and \`task_id\` when you know it. Teammates see these as progress updates.
- Before you stop, or when your context is getting full, call \`save_handoff\` with what is done, what is half done, and what comes next, so your person's next chat can continue without asking.
- If your task depends on work a teammate owns and only they or their agent can tell you, such as an API shape or a file they're changing, call \`ask_teammate\` instead of guessing. Use \`ask\` for decisions that need a human. Collect the reply with \`check_answers\`.
- If \`check_answers\`, \`get_context\` or a \`heads_up\` shows a teammate's question, answer it with \`answer_teammate\` from what you know. If you can't, ask your own person, or say you don't know. Don't leave it open.
- If a task depends on a product decision, business rule, or fact that isn't in the request or the code, do not guess it and do not ask your own human. Call \`search_decisions\` first. If no result decides it, call \`ask\` before writing the code that depends on it, passing \`task_id\` or \`files\` when you know them.
- If \`ask\` returns \`possible_duplicates\`, your question wasn't sent. If a candidate asks exactly the same thing, call \`join_question\`. If it only looks similar, for example a different subject, audience or limit, call \`ask\` again with \`confirmed_new: true\`.
- If you can't do useful work without the answer, call \`check_answers\` with \`wait_seconds: 240\` straight after \`ask\` or \`join_question\`. Your teammates are human and may take several minutes to reply. Waiting uses no tokens.
- If the answer only changes a detail you can easily change later, pass what you'll use as \`assumption\` in \`ask\` or \`join_question\` and keep working. Call \`check_answers\` without \`wait_seconds\` after each step.
- Before you finish, if an answer is still pending, call \`check_answers\` with \`wait_seconds: 240\`, up to three times. Follow the answer exactly. If it is still pending after that, finish what you can and say clearly that the answer is still pending.
- If \`check_answers\` returns a notice, a human rejected an assumption or changed a decision, and it overrides your earlier work. Change what you built on it right away and say what you changed. Do the same if an answer differs from \`your_assumption\`.
- Do not use \`ask\` for things you can work out from the code, or for ordinary engineering choices.
- Never put secrets in anything you send to these tools.
- If this is a Unity project (it has \`Assets/\` and \`ProjectSettings/\`): never edit \`Library/\`, \`Temp/\`, \`Obj/\`, \`Logs/\` or \`UserSettings/\`; keep each \`.meta\` file with its asset when you move, rename or delete it, and never change its \`guid\`; list the \`.unity\`, \`.prefab\` and \`.asset\` files a task touches in \`files\` when you create it, because two people's edits to one can't be merged. If \`claim_task\` returns a warning about \`unmergeable_files\`, don't edit those files until you have agreed with the owner through \`ask_teammate\`.
${BLOCK_END}`;

export const EDITORS = ["claude", "cursor", "codex"] as const;
export type Editor = (typeof EDITORS)[number];

export type ConnectionConfig = { supabaseUrl: string; publishableKey: string; teamId: string };

function readJson(file: string): Record<string, any> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${file} isn't valid JSON, so Hacky left it alone. Fix it and try again.`);
  }
}

const writeJson = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n");

// On native Windows, Claude Code can't launch npx directly and needs the cmd wrapper.
// The server version this extension was built with. npx keeps using whatever copy it cached first
// when no version is given, so every command names this one. Kept equal to
// packages/mcp-server/package.json by a test.
export const SERVER_VERSION = "0.1.2";
export const SERVER_PACKAGE = `hacky-mcp-server@${SERVER_VERSION}`;

function launchCommand(platform: NodeJS.Platform) {
  const npx = ["npx", "-y", SERVER_PACKAGE];
  return platform === "win32" ? { command: "cmd", args: ["/c", ...npx] } : { command: npx[0], args: npx.slice(1) };
}

function withManagedBlock(existing: string): string {
  const start = existing.indexOf(BLOCK_START);
  const end = existing.indexOf(BLOCK_END);
  if (start !== -1 && end > start) {
    return existing.slice(0, start) + MANAGED_BLOCK + existing.slice(end + BLOCK_END.length);
  }
  return existing ? `${existing.trimEnd()}\n\n${MANAGED_BLOCK}\n` : `${MANAGED_BLOCK}\n`;
}

function serverEntry(config: ConnectionConfig, platform: NodeJS.Platform) {
  return {
    ...launchCommand(platform),
    env: {
      HACKY_SUPABASE_URL: config.supabaseUrl,
      HACKY_SUPABASE_PUBLISHABLE_KEY: config.publishableKey,
      HACKY_TEAM_ID: config.teamId,
    },
  };
}

function readText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

// Claude Code and Cursor share the same .mcp.json layout.
function writeMcpJson(file: string, config: ConnectionConfig, platform: NodeJS.Platform) {
  const mcp = readJson(file);
  mcp.mcpServers = { ...mcp.mcpServers, [SERVER_NAME]: serverEntry(config, platform) };
  mkdirSync(dirname(file), { recursive: true });
  writeJson(file, mcp);
}

const TOML_START = "# hacky:start";
const TOML_END = "# hacky:end";
const toml = (value: string) => JSON.stringify(value);

// Codex reads MCP servers from TOML. Only the marked section is ours.
function codexSection(config: ConnectionConfig, platform: NodeJS.Platform): string {
  const { command, args, env } = serverEntry(config, platform);
  return `${TOML_START}
[mcp_servers.${SERVER_NAME}]
command = ${toml(command)}
args = [${args.map(toml).join(", ")}]

[mcp_servers.${SERVER_NAME}.env]
${Object.entries(env).map(([key, value]) => `${key} = ${toml(value)}`).join("\n")}
${TOML_END}`;
}

function writeCodexConfig(file: string, config: ConnectionConfig, platform: NodeJS.Platform) {
  const existing = readText(file);
  const section = codexSection(config, platform);
  const start = existing.indexOf(TOML_START);
  const end = existing.indexOf(TOML_END);
  let next: string;
  if (start !== -1 && end > start) {
    next = existing.slice(0, start) + section + existing.slice(end + TOML_END.length);
  } else {
    // A second [mcp_servers.hacky] table would make Codex refuse the whole file.
    if (/^\s*\[mcp_servers\.hacky[\].]/m.test(existing)) {
      throw new Error(`${file} already defines a hacky server, so Hacky left it alone. Remove that section and try again.`);
    }
    next = existing ? `${existing.trimEnd()}\n\n${section}\n` : `${section}\n`;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);
}

const CURSOR_RULE_HEADER = "---\ndescription: Team coordination with Hacky\nalwaysApply: true\n---\n\n";

function writeBlockFile(file: string, header = "") {
  const existing = readText(file);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, existing ? withManagedBlock(existing) : `${header}${MANAGED_BLOCK}\n`);
}

// The Claude Code hook that reports which files the agent edits, so the board can show who is
// touching what. It only sends paths, and never stops an edit.
export const TOUCH_HOOK_COMMAND = `npx -y ${SERVER_PACKAGE} touch`;
const isTouchHook = (command: string | undefined) => /hacky-mcp-server(@\S+)? touch/.test(command ?? "");
const TOUCH_HOOK_MATCHER = "Edit|Write|MultiEdit|NotebookEdit";

type HookGroup = { matcher?: string; hooks?: { type?: string; command?: string }[] };

// Adds the hook to the settings once, next to any hooks the person already has. A hook from an
// older version is moved to this version's command in place.
export function withTouchHook(settings: Record<string, any>): Record<string, any> {
  const groups: HookGroup[] = settings.hooks?.PostToolUse ?? [];
  const present = groups.some((group) => group.hooks?.some((hook) => isTouchHook(hook.command)));
  if (present) {
    const updated = groups.map((group) => ({
      ...group,
      hooks: group.hooks?.map((hook) => (isTouchHook(hook.command) ? { ...hook, command: TOUCH_HOOK_COMMAND } : hook)),
    }));
    return { ...settings, hooks: { ...settings.hooks, PostToolUse: updated } };
  }
  const group = { matcher: TOUCH_HOOK_MATCHER, hooks: [{ type: "command", command: TOUCH_HOOK_COMMAND, timeout: 15 }] };
  return { ...settings, hooks: { ...settings.hooks, PostToolUse: [...groups, group] } };
}

export function connectWorkspace(
  dir: string,
  config: ConnectionConfig,
  platform: NodeJS.Platform = process.platform,
  editors: readonly Editor[] = ["claude"],
) {
  if (!editors.length) throw new Error("Choose at least one tool to connect.");

  // Read every file that must be valid JSON first, so a broken one stops the whole connect.
  const claude = editors.includes("claude");
  const settingsFile = join(dir, ".claude", "settings.local.json");
  const settings = claude ? readJson(settingsFile) : {};
  if (claude) readJson(join(dir, ".mcp.json"));
  if (editors.includes("cursor")) readJson(join(dir, ".cursor", "mcp.json"));

  if (claude) {
    writeMcpJson(join(dir, ".mcp.json"), config, platform);
    // Approves this one server and its tools for this user only, so agents aren't stopped
    // by a prompt on every call. Nothing else is allowed by this.
    settings.enabledMcpjsonServers = [...new Set([...(settings.enabledMcpjsonServers ?? []), SERVER_NAME])];
    settings.permissions = {
      ...settings.permissions,
      allow: [...new Set([...(settings.permissions?.allow ?? []), `mcp__${SERVER_NAME}`])],
    };
    mkdirSync(dirname(settingsFile), { recursive: true });
    writeJson(settingsFile, withTouchHook(settings));
    writeBlockFile(join(dir, "CLAUDE.md"));
  }
  if (editors.includes("cursor")) {
    writeMcpJson(join(dir, ".cursor", "mcp.json"), config, platform);
    writeBlockFile(join(dir, ".cursor", "rules", "hacky.mdc"), CURSOR_RULE_HEADER);
  }
  if (editors.includes("codex")) {
    writeCodexConfig(join(dir, ".codex", "config.toml"), config, platform);
    writeBlockFile(join(dir, "AGENTS.md"));
  }
}

// The files that hold the Hacky instructions, one per tool.
const INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md", join(".cursor", "rules", "hacky.mdc")];

// Whether every instruction file with a Hacky block holds this version's block, and there is
// at least one. An upgrade changes the block, and connecting again is what refreshes it, so
// this is how the sidebar knows to offer that.
export function managedBlockIsCurrent(dir: string): boolean {
  let current = false;
  for (const name of INSTRUCTION_FILES) {
    const text = readText(join(dir, name));
    const start = text.indexOf(BLOCK_START);
    if (start === -1) continue;
    const end = text.indexOf(BLOCK_END);
    if (end <= start || text.slice(start, end + BLOCK_END.length) !== MANAGED_BLOCK) return false;
    current = true;
  }
  return current && serverIsCurrent(dir);
}

// Whether every tool config that starts Hacky starts this version, and the Claude hook does too.
function serverIsCurrent(dir: string): boolean {
  for (const file of [join(dir, ".mcp.json"), join(dir, ".cursor", "mcp.json")]) {
    let entry: { args?: unknown } | undefined;
    try {
      entry = readJson(file).mcpServers?.[SERVER_NAME];
    } catch {
      continue;
    }
    if (entry && !(Array.isArray(entry.args) && entry.args.includes(SERVER_PACKAGE))) return false;
  }
  const codex = readText(join(dir, ".codex", "config.toml"));
  if (codex.includes("hacky-mcp-server") && !codex.includes(SERVER_PACKAGE)) return false;
  try {
    const groups: HookGroup[] = readJson(join(dir, ".claude", "settings.local.json")).hooks?.PostToolUse ?? [];
    if (groups.some((group) => group.hooks?.some((hook) => isTouchHook(hook.command) && hook.command !== TOUCH_HOOK_COMMAND))) return false;
  } catch {
    // A broken settings file is reported when connecting.
  }
  return true;
}

// The team a folder is connected to, from whichever tool's config holds Hacky.
export function connectedTeamId(dir: string): string | null {
  for (const file of [join(dir, ".mcp.json"), join(dir, ".cursor", "mcp.json")]) {
    try {
      const id = readJson(file).mcpServers?.[SERVER_NAME]?.env?.HACKY_TEAM_ID;
      if (id) return id;
    } catch {
      // A broken file just doesn't count as connected.
    }
  }
  try {
    const text = readText(join(dir, ".codex", "config.toml"));
    return /^HACKY_TEAM_ID = "([^"]+)"/m.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}
