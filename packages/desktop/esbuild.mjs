// Bundles the app. Only the project URL and publishable key are embedded: both are safe to ship
// because RLS protects the data. The secret key must never be added here.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
  throw new Error("Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in .env");
}

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

const common = { bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron", "@lydell/node-pty"], sourcemap: true };
await build({
  ...common,
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.cjs",
  define: {
    __SUPABASE_URL__: JSON.stringify(SUPABASE_URL),
    __SUPABASE_PUBLISHABLE_KEY__: JSON.stringify(SUPABASE_PUBLISHABLE_KEY),
    // The GitHub OAuth App's client ID for Sign in with GitHub. Public by design, like the key above.
    // Without it the app offers only "use a token".
    __GITHUB_CLIENT_ID__: JSON.stringify(process.env.GITHUB_CLIENT_ID ?? ""),
  },
});
await build({ ...common, entryPoints: ["src/preload.ts"], outfile: "dist/preload.cjs" });
// The Terminal screen runs in a browser page, so it is bundled with xterm.js for that.
await build({ bundle: true, platform: "browser", format: "iife", target: "chrome140", sourcemap: true, entryPoints: ["page/terminal.js"], outfile: "dist/static/terminal.js" });

// Node 24's cpSync crashes the process when copying a folder whose path has non-ASCII characters
// (such as a Cyrillic folder name), so folders are copied file by file.
function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target);
    else copyFileSync(source, target);
  }
}

// The screens are the extension's own files, so a design change lands in both.
copyDir("../extension/media", "dist/media");
copyDir("static", "dist/static");
copyFileSync("../../node_modules/@xterm/xterm/css/xterm.css", "dist/static/xterm.css");
copyFileSync("../extension/media/icon.png", "dist/icon.png");
