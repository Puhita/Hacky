// Runs before `npm pack` / `npm publish`: builds the extension and bundles its .vsix,
// so the package can never go out with a stale or missing extension.
import { execSync } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(here, "..", "extension");
const extension = JSON.parse(readFileSync(join(extensionDir, "package.json"), "utf8"));
const mine = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));

if (extension.version !== mine.version) {
  throw new Error(`Set hacky-vscode to ${extension.version} (the extension's version) before publishing; it is ${mine.version}.`);
}
execSync("npm run package", { cwd: extensionDir, stdio: "inherit" });
copyFileSync(join(extensionDir, `hacky-${extension.version}.vsix`), join(here, "hacky.vsix"));
