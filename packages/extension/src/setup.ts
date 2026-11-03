// Connects a workspace to a team: registers the MCP server for Claude Code and tells
// agents to use it. Existing content in these files is always preserved.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
${BLOCK_END}`;

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
function launchCommand(platform: NodeJS.Platform) {
  const npx = ["npx", "-y", "hacky-mcp-server"];
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

export function connectWorkspace(dir: string, config: ConnectionConfig, platform: NodeJS.Platform = process.platform) {
  const mcpFile = join(dir, ".mcp.json");
  const mcp = readJson(mcpFile);

  const settingsDir = join(dir, ".claude");
  const settingsFile = join(settingsDir, "settings.local.json");
  const settings = readJson(settingsFile);

  mcp.mcpServers = {
    ...mcp.mcpServers,
    [SERVER_NAME]: {
      ...launchCommand(platform),
      env: {
        HACKY_SUPABASE_URL: config.supabaseUrl,
        HACKY_SUPABASE_PUBLISHABLE_KEY: config.publishableKey,
        HACKY_TEAM_ID: config.teamId,
      },
    },
  };
  writeJson(mcpFile, mcp);

  // Approves this one server and its tools for this user only, so agents aren't stopped
  // by a prompt on every call. Nothing else is allowed by this.
  settings.enabledMcpjsonServers = [...new Set([...(settings.enabledMcpjsonServers ?? []), SERVER_NAME])];
  settings.permissions = {
    ...settings.permissions,
    allow: [...new Set([...(settings.permissions?.allow ?? []), `mcp__${SERVER_NAME}`])],
  };
  mkdirSync(settingsDir, { recursive: true });
  writeJson(settingsFile, settings);

  const claudeFile = join(dir, "CLAUDE.md");
  let existing = "";
  try {
    existing = readFileSync(claudeFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  writeFileSync(claudeFile, withManagedBlock(existing));
}

// Whether CLAUDE.md holds this version's Hacky block. An upgrade changes the block, and
// connecting again is what refreshes it, so this is how the sidebar knows to offer that.
export function managedBlockIsCurrent(dir: string): boolean {
  let text: string;
  try {
    text = readFileSync(join(dir, "CLAUDE.md"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const start = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END);
  return start !== -1 && end > start && text.slice(start, end + BLOCK_END.length) === MANAGED_BLOCK;
}

export function connectedTeamId(dir: string): string | null {
  try {
    return readJson(join(dir, ".mcp.json")).mcpServers?.[SERVER_NAME]?.env?.HACKY_TEAM_ID ?? null;
  } catch {
    return null;
  }
}
