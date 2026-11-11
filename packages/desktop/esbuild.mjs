// Bundles the app. Only the project URL and publishable key are embedded: both are safe to ship
// because RLS protects the data. The secret key must never be added here.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

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
  },
});
await build({ ...common, entryPoints: ["src/preload.ts"], outfile: "dist/preload.cjs" });
// The Terminal screen runs in a browser page, so it is bundled with xterm.js for that.
await build({ bundle: true, platform: "browser", format: "iife", target: "chrome140", sourcemap: true, entryPoints: ["page/terminal.js"], outfile: "dist/static/terminal.js" });

// The screens are the extension's own files, so a design change lands in both.
cpSync("../extension/media", "dist/media", { recursive: true });
cpSync("static", "dist/static", { recursive: true });
cpSync("../../node_modules/@xterm/xterm/css/xterm.css", "dist/static/xterm.css");
cpSync("../extension/media/icon.png", "dist/icon.png");
