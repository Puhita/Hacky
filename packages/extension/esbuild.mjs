// Bundles the extension. Only the project URL and publishable key are embedded: both are
// safe to ship because RLS protects the data. The secret key must never be added here.
import { build } from "esbuild";

const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
  throw new Error("Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in .env");
}

await build({
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  sourcemap: true,
  define: {
    __SUPABASE_URL__: JSON.stringify(SUPABASE_URL),
    __SUPABASE_PUBLISHABLE_KEY__: JSON.stringify(SUPABASE_PUBLISHABLE_KEY),
  },
});
