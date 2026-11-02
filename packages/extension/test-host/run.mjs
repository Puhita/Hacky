// Launches a clean copy of VS Code with the extension loaded and runs smoke.cjs inside it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

// Set when this runs from inside another VS Code, and would make Electron start as plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

const here = dirname(fileURLToPath(import.meta.url));
const workspace = mkdtempSync(join(tmpdir(), "hacky-host-workspace-"));
try {
  await runTests({
    extensionDevelopmentPath: resolve(here, ".."),
    extensionTestsPath: join(here, "smoke.cjs"),
    launchArgs: [workspace, "--disable-extensions", "--disable-gpu"],
  });
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
