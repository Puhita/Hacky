import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { connectedTeamId, connectWorkspace, managedBlockIsCurrent, MANAGED_BLOCK, TOUCH_HOOK_COMMAND, withTouchHook } from "./setup.js";

const CONFIG = { supabaseUrl: "https://x.supabase.co", publishableKey: "sb_publishable_x", teamId: "team-1" };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hacky-setup-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const read = (file: string) => readFileSync(join(dir, file), "utf8");
const readJson = (file: string) => JSON.parse(read(file));

test("sets up an empty folder", () => {
  connectWorkspace(dir, CONFIG, "linux");
  const server = readJson(".mcp.json").mcpServers.hacky;
  assert.equal(server.command, "npx");
  assert.deepEqual(server.args, ["-y", "hacky-mcp-server"]);
  assert.deepEqual(server.env, {
    HACKY_SUPABASE_URL: CONFIG.supabaseUrl,
    HACKY_SUPABASE_PUBLISHABLE_KEY: CONFIG.publishableKey,
    HACKY_TEAM_ID: "team-1",
  });
  assert.ok(read("CLAUDE.md").includes(MANAGED_BLOCK));
  const settings = readJson(".claude/settings.local.json");
  assert.deepEqual(settings.enabledMcpjsonServers, ["hacky"]);
  assert.deepEqual(settings.permissions.allow, ["mcp__hacky"]);
  assert.equal(connectedTeamId(dir), "team-1");
});

test("uses the cmd wrapper on Windows", () => {
  connectWorkspace(dir, CONFIG, "win32");
  const server = readJson(".mcp.json").mcpServers.hacky;
  assert.equal(server.command, "cmd");
  assert.deepEqual(server.args, ["/c", "npx", "-y", "hacky-mcp-server"]);
});

test("keeps everything already in the user's files", () => {
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "other" } }, extra: 1 }));
  writeFileSync(join(dir, "CLAUDE.md"), "# My project\n\nMy rules.\n");
  mkdirSync(join(dir, ".claude"));
  writeFileSync(
    join(dir, ".claude/settings.local.json"),
    JSON.stringify({ permissions: { allow: ["Bash(ls)"], deny: ["Read(.env)"] }, enabledMcpjsonServers: ["other"], model: "x" }),
  );

  connectWorkspace(dir, CONFIG, "linux");

  const mcp = readJson(".mcp.json");
  assert.deepEqual(mcp.mcpServers.other, { command: "other" });
  assert.equal(mcp.extra, 1);
  assert.ok(mcp.mcpServers.hacky);
  assert.ok(read("CLAUDE.md").startsWith("# My project\n\nMy rules.\n"));
  assert.ok(read("CLAUDE.md").includes(MANAGED_BLOCK));
  const settings = readJson(".claude/settings.local.json");
  assert.deepEqual(settings.permissions, { allow: ["Bash(ls)", "mcp__hacky"], deny: ["Read(.env)"] });
  assert.deepEqual(settings.enabledMcpjsonServers, ["other", "hacky"]);
  assert.equal(settings.model, "x");
  assert.equal(settings.hooks.PostToolUse.length, 1, "the file-touch hook is added");
});

test("connecting twice changes nothing, and replaces only the managed block", () => {
  writeFileSync(join(dir, "CLAUDE.md"), "Before\n\n<!-- hacky:start -->\nold text\n<!-- hacky:end -->\n\nAfter\n");
  connectWorkspace(dir, CONFIG, "linux");
  const first = [read(".mcp.json"), read("CLAUDE.md"), read(".claude/settings.local.json")];
  connectWorkspace(dir, CONFIG, "linux");
  assert.deepEqual([read(".mcp.json"), read("CLAUDE.md"), read(".claude/settings.local.json")], first);
  assert.equal(read("CLAUDE.md"), `Before\n\n${MANAGED_BLOCK}\n\nAfter\n`);
});

test("reconnecting to another team updates the team id", () => {
  connectWorkspace(dir, CONFIG, "linux");
  connectWorkspace(dir, { ...CONFIG, teamId: "team-2" }, "linux");
  assert.equal(connectedTeamId(dir), "team-2");
});

test("refuses to overwrite a broken .mcp.json, and changes no other file", () => {
  writeFileSync(join(dir, ".mcp.json"), "{ not json");
  assert.throws(() => connectWorkspace(dir, CONFIG, "linux"), /isn't valid JSON/);
  assert.equal(read(".mcp.json"), "{ not json");
  assert.throws(() => read("CLAUDE.md"));
  assert.equal(connectedTeamId(dir), null);
});

test("refuses a broken settings file before writing anything", () => {
  mkdirSync(join(dir, ".claude"));
  writeFileSync(join(dir, ".claude/settings.local.json"), "{ not json");
  assert.throws(() => connectWorkspace(dir, CONFIG, "linux"), /isn't valid JSON/);
  assert.throws(() => read(".mcp.json"));
});

test("a folder with no setup isn't connected", () => {
  assert.equal(connectedTeamId(dir), null);
});

test("the managed block is current after connecting, with the user's own text around it", () => {
  writeFileSync(join(dir, "CLAUDE.md"), "My own notes\n");
  connectWorkspace(dir, CONFIG, "linux");
  assert.equal(managedBlockIsCurrent(dir), true);
  writeFileSync(join(dir, "CLAUDE.md"), `Before\n\n${MANAGED_BLOCK}\n\nAfter\n`);
  assert.equal(managedBlockIsCurrent(dir), true, "text outside the markers doesn't matter");
});

test("an older block, a missing block and a missing file are all out of date", () => {
  assert.equal(managedBlockIsCurrent(dir), false, "no CLAUDE.md");
  writeFileSync(join(dir, "CLAUDE.md"), "Just my notes\n");
  assert.equal(managedBlockIsCurrent(dir), false, "no block");
  writeFileSync(join(dir, "CLAUDE.md"), "<!-- hacky:start -->\nold text\n<!-- hacky:end -->\n");
  assert.equal(managedBlockIsCurrent(dir), false, "an older block");
  writeFileSync(join(dir, "CLAUDE.md"), `${MANAGED_BLOCK.replace("<!-- hacky:end -->", "")}\n`);
  assert.equal(managedBlockIsCurrent(dir), false, "no end marker");
});

test("connecting again brings an older block up to date and keeps the rest", () => {
  writeFileSync(join(dir, "CLAUDE.md"), "Before\n\n<!-- hacky:start -->\nold text\n<!-- hacky:end -->\n\nAfter\n");
  connectWorkspace(dir, CONFIG, "linux");
  assert.equal(managedBlockIsCurrent(dir), true);
  assert.equal(read("CLAUDE.md"), `Before\n\n${MANAGED_BLOCK}\n\nAfter\n`);
});

test("connects Cursor with its own config and rules file", () => {
  connectWorkspace(dir, CONFIG, "linux", ["cursor"]);
  assert.equal(readJson(".cursor/mcp.json").mcpServers.hacky.env.HACKY_TEAM_ID, "team-1");
  const rules = read(".cursor/rules/hacky.mdc");
  assert.ok(rules.startsWith("---\ndescription:"));
  assert.ok(rules.includes("alwaysApply: true"));
  assert.ok(rules.includes(MANAGED_BLOCK));
  assert.throws(() => read(".mcp.json"), "Claude Code's files are untouched");
  assert.throws(() => read("CLAUDE.md"));
  assert.equal(connectedTeamId(dir), "team-1");
  assert.equal(managedBlockIsCurrent(dir), true);
});

test("connects Codex with a TOML section and AGENTS.md", () => {
  writeFileSync(join(dir, "AGENTS.md"), "# Mine\n");
  mkdirSync(join(dir, ".codex"));
  writeFileSync(join(dir, ".codex/config.toml"), 'model = "gpt-x"\n\n[mcp_servers.other]\ncommand = "other"\n');
  connectWorkspace(dir, CONFIG, "win32", ["codex"]);
  const toml = read(".codex/config.toml");
  assert.ok(toml.startsWith('model = "gpt-x"\n\n[mcp_servers.other]\ncommand = "other"\n'));
  assert.ok(toml.includes('[mcp_servers.hacky]\ncommand = "cmd"\nargs = ["/c", "npx", "-y", "hacky-mcp-server"]'));
  assert.ok(toml.includes('HACKY_TEAM_ID = "team-1"'));
  assert.ok(read("AGENTS.md").startsWith("# Mine\n"));
  assert.ok(read("AGENTS.md").includes(MANAGED_BLOCK));
  assert.equal(connectedTeamId(dir), "team-1");
});

test("connecting Codex again replaces only its own section", () => {
  connectWorkspace(dir, CONFIG, "linux", ["codex"]);
  connectWorkspace(dir, { ...CONFIG, teamId: "team-2" }, "linux", ["codex"]);
  const toml = read(".codex/config.toml");
  assert.equal(toml.match(/\[mcp_servers\.hacky\]/g)?.length, 1);
  assert.equal(connectedTeamId(dir), "team-2");
});

test("Codex refuses a hacky server it didn't write", () => {
  mkdirSync(join(dir, ".codex"));
  writeFileSync(join(dir, ".codex/config.toml"), '[mcp_servers.hacky]\ncommand = "x"\n');
  assert.throws(() => connectWorkspace(dir, CONFIG, "linux", ["codex"]), /already defines a hacky server/);
  assert.equal(read(".codex/config.toml"), '[mcp_servers.hacky]\ncommand = "x"\n');
});

test("connects several tools at once, and one broken file stops all of them", () => {
  connectWorkspace(dir, CONFIG, "linux", ["claude", "cursor", "codex"]);
  assert.ok(read(".mcp.json") && read(".cursor/mcp.json") && read(".codex/config.toml"));
  const other = mkdtempSync(join(tmpdir(), "hacky-setup-"));
  try {
    mkdirSync(join(other, ".cursor"));
    writeFileSync(join(other, ".cursor/mcp.json"), "{ nope");
    assert.throws(() => connectWorkspace(other, CONFIG, "linux", ["claude", "cursor"]), /isn't valid JSON/);
    assert.throws(() => readFileSync(join(other, ".mcp.json")), "nothing was written");
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

test("an outdated block in any tool's file counts as outdated", () => {
  connectWorkspace(dir, CONFIG, "linux", ["claude", "codex"]);
  writeFileSync(join(dir, "AGENTS.md"), "<!-- hacky:start -->\nold\n<!-- hacky:end -->\n");
  assert.equal(managedBlockIsCurrent(dir), false);
});

test("needs at least one tool", () => {
  assert.throws(() => connectWorkspace(dir, CONFIG, "linux", []), /at least one/);
});

test("the managed block carries the Unity rules", () => {
  for (const rule of ["Library/", ".meta", "guid", ".unity", ".prefab", "unmergeable_files", "ask_teammate"]) {
    assert.ok(MANAGED_BLOCK.includes(rule), `block mentions ${rule}`);
  }
  assert.ok(MANAGED_BLOCK.includes("If this is a Unity project"), "the rules only apply to Unity projects");
});

test("the file-touch hook is added once for Claude Code, next to the person's own hooks", () => {
  mkdirSync(join(dir, ".claude"));
  const mine = { matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] };
  writeFileSync(join(dir, ".claude/settings.local.json"), JSON.stringify({ hooks: { PostToolUse: [mine], SessionStart: [mine] } }));
  connectWorkspace(dir, CONFIG, "linux");
  connectWorkspace(dir, CONFIG, "linux");
  const hooks = readJson(".claude/settings.local.json").hooks;
  assert.equal(hooks.PostToolUse.length, 2);
  assert.deepEqual(hooks.PostToolUse[0], mine);
  assert.equal(hooks.PostToolUse[1].matcher, "Edit|Write|MultiEdit|NotebookEdit");
  assert.equal(hooks.PostToolUse[1].hooks[0].command, TOUCH_HOOK_COMMAND);
  assert.deepEqual(hooks.SessionStart, [mine]);
});

test("Cursor and Codex get no hook, since they have no such hook", () => {
  connectWorkspace(dir, CONFIG, "linux", ["cursor", "codex"]);
  assert.throws(() => readJson(".claude/settings.local.json"));
});

test("withTouchHook leaves settings that already have the hook unchanged", () => {
  const once = withTouchHook({});
  assert.deepEqual(withTouchHook(once), once);
});
