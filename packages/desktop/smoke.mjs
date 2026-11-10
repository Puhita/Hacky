// Runs the built app once in test mode: it takes a picture of each screen, writes report.json
// into a temporary folder and quits. Fails if a screen stayed empty or logged an error.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const electron = createRequire(import.meta.url)("electron");
const dir = process.env.HACKY_SMOKE_DIR ?? mkdtempSync(join(tmpdir(), "hacky-smoke-"));
const env = { ...process.env, HACKY_SMOKE_DIR: dir };
// Set inside VS Code's own processes; with it Electron would run as plain Node.
delete env.ELECTRON_RUN_AS_NODE;
spawnSync(electron, ["."], { env, stdio: "inherit", timeout: 120_000 });

const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
const empty = ["sidebar", "board", "map"].filter((name) => !report[name]?.textLength);
console.log(`Screenshots and report: ${dir}`);
if (empty.length || report.problems.length || !report.mapTabOpened) {
  console.error({ empty, problems: report.problems, mapTabOpened: report.mapTabOpened });
  process.exit(1);
}
console.log("Smoke test passed.");
