import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { connectedTeamId, connectWorkspace, MANAGED_BLOCK } from "./setup.js";

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
  assert.deepEqual(readJson(".claude/settings.local.json"), {
    permissions: { allow: ["Bash(ls)", "mcp__hacky"], deny: ["Read(.env)"] },
    enabledMcpjsonServers: ["other", "hacky"],
    model: "x",
  });
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
