#!/usr/bin/env node
// Installs the bundled Hacky extension into VS Code (or Cursor / VS Code Insiders).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const vsix = join(dirname(fileURLToPath(import.meta.url)), "hacky.vsix");
const EDITORS = ["code", "cursor", "code-insiders"];
// On Windows the editor commands are .cmd files, which need a shell to start.
const shell = process.platform === "win32";

const quote = (text) => (shell ? `"${text}"` : text);
const run = (editor, args) => spawnSync(editor, args.map(quote), { shell, encoding: "utf8" });
const available = (editor) => run(editor, ["--version"]).status === 0;

const wanted = process.argv[2]?.startsWith("--editor=") ? process.argv[2].slice("--editor=".length) : null;
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: npx -y hacky-vscode [--editor=code|cursor|code-insiders]");
  process.exit(0);
}
if (wanted && !EDITORS.includes(wanted)) {
  console.error(`Unknown editor "${wanted}". Use one of: ${EDITORS.join(", ")}.`);
  process.exit(1);
}
if (!existsSync(vsix)) {
  console.error("This package is missing its extension file. Reinstall it with: npx -y hacky-vscode@latest");
  process.exit(1);
}

const editor = (wanted ? [wanted] : EDITORS).find(available);
if (!editor) {
  console.error(
    [
      `Could not find ${wanted ?? "VS Code"}'s command line tool.`,
      "In VS Code, open the Command Palette and run: Shell Command: Install 'code' command in PATH.",
      `Or install the file by hand: Extensions view, "..." menu, Install from VSIX, then choose:`,
      `  ${vsix}`,
    ].join("\n"),
  );
  process.exit(1);
}

const result = run(editor, ["--install-extension", vsix, "--force"]);
if (result.status !== 0) {
  console.error(result.stderr || result.stdout || "The install failed.");
  process.exit(result.status ?? 1);
}
console.log(`Hacky is installed in ${editor}.`);
console.log("Quit and reopen the editor, then open the Hacky icon in the activity bar to sign in.");
