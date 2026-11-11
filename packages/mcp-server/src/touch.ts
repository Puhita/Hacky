// `hacky-mcp-server touch`: the command a Claude Code PostToolUse hook runs after an agent edits a
// file. It reports the path (never the content) so teammates can see who is touching what. It must
// never get in the way of an edit, so every failure is swallowed and the exit code is always 0.
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { defaultCredentialsFile, fileStorage } from "./credentials.js";
import { redact } from "./redact.js";

// Folders and files that are noise, or may hold secrets, are not reported.
const SKIPPED_SEGMENTS = new Set([".git", "node_modules"]);
const SKIPPED_FILE = /^\.env(\..*)?$/;

// The path an edit touched, relative to the project with forward slashes. Null when the hook input
// has no file, the file is outside the project, or it is one we never report.
export function touchedPath(input: unknown, projectDir: string): string | null {
  const toolInput = (input as { tool_input?: { file_path?: unknown; notebook_path?: unknown } } | null)?.tool_input;
  const raw = toolInput?.file_path ?? toolInput?.notebook_path;
  if (typeof raw !== "string" || raw === "") return null;
  const root = resolve(projectDir);
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  const inside = relative(root, absolute);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return null;
  const segments = inside.split(sep);
  if (segments.some((segment) => SKIPPED_SEGMENTS.has(segment)) || SKIPPED_FILE.test(segments[segments.length - 1])) return null;
  return segments.join("/");
}

type ServerEnv = { HACKY_SUPABASE_URL?: string; HACKY_SUPABASE_PUBLISHABLE_KEY?: string; HACKY_TEAM_ID?: string; HACKY_CREDENTIALS_FILE?: string };

// The Hacky server's settings from the folder's .mcp.json, which is where Connect this folder put them.
export function serverEnvFrom(projectDir: string): ServerEnv | null {
  try {
    const mcp = JSON.parse(readFileSync(join(projectDir, ".mcp.json"), "utf8"));
    return mcp?.mcpServers?.hacky?.env ?? null;
  } catch {
    return null;
  }
}

export async function runTouch(stdin: string, environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    const input = JSON.parse(stdin);
    const projectDir = environment.CLAUDE_PROJECT_DIR || (typeof input?.cwd === "string" ? input.cwd : process.cwd());
    const path = touchedPath(input, projectDir);
    const env = serverEnvFrom(projectDir);
    if (!path || !env?.HACKY_SUPABASE_URL || !env.HACKY_SUPABASE_PUBLISHABLE_KEY || !env.HACKY_TEAM_ID) return;
    const supabase = createClient(env.HACKY_SUPABASE_URL, env.HACKY_SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        storage: fileStorage(env.HACKY_CREDENTIALS_FILE || defaultCredentialsFile()),
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
    await supabase.rpc("record_file_touch", { target_team: env.HACKY_TEAM_ID, touched_path: redact(path) });
  } catch {
    // Never block an edit.
  }
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
