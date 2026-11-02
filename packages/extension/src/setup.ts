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

- At the start of a session, call \`get_context\`. If it shows an answer ready, collect it with \`check_answers\`.
- Before working on a task from the team board, call \`claim_task\`. If it says a teammate owns the task, leave it alone. Call \`complete_task\` when you finish one.
- When you finish a chunk of work, call \`log_progress\`.
- If a task depends on a product decision, business rule, or fact that isn't in the request or the code, do not guess it and do not ask your own human. Call \`search_decisions\` first. If no result decides it, call \`ask\` before writing the code that depends on it, passing \`task_id\` or \`files\` when you know them.
- If \`ask\` returns \`possible_duplicates\`, your question wasn't sent. If a candidate asks exactly the same thing, call \`join_question\`. If it only looks similar, for example a different subject, audience or limit, call \`ask\` again with \`confirmed_new: true\`.
- After \`ask\` or \`join_question\`, call \`check_answers\` with \`wait_seconds: 240\`. Your teammates are human and may take several minutes to reply. Waiting uses no tokens. If the answer is still pending, call it again, up to three times, then follow the answer exactly.
- If it is still pending after that, finish what you can and say clearly that the answer is still pending.
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

export function connectedTeamId(dir: string): string | null {
  try {
    return readJson(join(dir, ".mcp.json")).mcpServers?.[SERVER_NAME]?.env?.HACKY_TEAM_ID ?? null;
  } catch {
    return null;
  }
}
