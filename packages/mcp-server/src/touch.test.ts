// The pure part of the file-touch hook: which path a hook input reports.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { serverEnvFrom, touchedPath } from "./touch.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const project = join(tmpdir(), "hacky-project");
const edit = (file_path: string) => ({ tool_name: "Edit", tool_input: { file_path } });

test("a path inside the project is reported relative, with forward slashes", () => {
  assert.equal(touchedPath(edit(join(project, "src", "app.ts")), project), "src/app.ts");
  assert.equal(touchedPath(edit("src/app.ts"), project), "src/app.ts");
  assert.equal(touchedPath({ tool_input: { notebook_path: join(project, "a.ipynb") } }, project), "a.ipynb");
});

test("files outside the project, noise and secrets are never reported", () => {
  assert.equal(touchedPath(edit(join(project, "..", "other", "a.ts")), project), null);
  assert.equal(touchedPath(edit(join(tmpdir(), "elsewhere.ts")), project), null);
  assert.equal(touchedPath(edit(project), project), null);
  assert.equal(touchedPath(edit(join(project, "node_modules", "x", "i.js")), project), null);
  assert.equal(touchedPath(edit(join(project, ".git", "config")), project), null);
  assert.equal(touchedPath(edit(join(project, ".env")), project), null);
  assert.equal(touchedPath(edit(join(project, "app", ".env.local")), project), null);
  assert.equal(touchedPath(edit(join(project, ".envrc.md")), project), ".envrc.md", "only real .env files are skipped");
});

test("input without a file is ignored", () => {
  for (const input of [null, {}, { tool_input: {} }, { tool_input: { file_path: 5 } }, { tool_input: { file_path: "" } }]) {
    assert.equal(touchedPath(input, project), null);
  }
});

test("the server settings come from the folder's .mcp.json, and a missing file is not an error", () => {
  const dir = mkdtempSync(join(tmpdir(), "hacky-touch-"));
  try {
    assert.equal(serverEnvFrom(dir), null);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { hacky: { env: { HACKY_TEAM_ID: "t1" } } } }));
    assert.deepEqual(serverEnvFrom(dir), { HACKY_TEAM_ID: "t1" });
    writeFileSync(join(dir, ".mcp.json"), "not json");
    assert.equal(serverEnvFrom(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
