// Step 3 end-to-end check. Uses the sidebar's real logic to connect a folder, then starts
// Claude Code relying only on the files setup wrote: no MCP or permission flags. A teammate
// answers through the inbox logic. The server isn't on npm yet, so .mcp.json is pointed at a
// packed copy; that package source is the only thing changed from what setup wrote.
// Run from the repo root: node --env-file=.env spike/compliance/setup-e2e.mjs --out <dir> --tarball <file>
// Needs CLAUDE_BIN, the built server, and the extension compiled to packages/extension/out.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { HackyApi } from "../../packages/extension/out/api.js";
import { SidebarController } from "../../packages/extension/out/controller.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ANSWER_AFTER_MS = 30_000;
const ANSWER = "Loyalty members get 17% off the cart total. Pass membership as an isLoyaltyMember argument.";

const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY, CLAUDE_BIN } = process.env;
const { values: args } = parseArgs({ options: { out: { type: "string" }, tarball: { type: "string" } } });
const OUT = resolve(args.out);
const admin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const checks = [];
const check = (name, passed, detail = "") => {
  checks.push(passed);
  console.log(`${passed ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

const userIds = [];
async function sidebar(label, workspace) {
  const email = `hacky-test-${label}-${randomBytes(6).toString("hex")}@example.com`;
  const password = randomBytes(24).toString("hex");
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  userIds.push(created.data.user.id);
  const credentials = join(OUT, `${label}-credentials.json`);
  const api = new HackyApi(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, credentials);
  const states = [];
  let saved;
  const controller = new SidebarController({
    api,
    supabaseUrl: SUPABASE_URL,
    publishableKey: SUPABASE_PUBLISHABLE_KEY,
    workspaceDir: () => workspace,
    loadTeamId: () => saved,
    saveTeamId: (teamId) => (saved = teamId),
    post: (state) => states.push(state),
  });
  await controller.handle({ type: "signIn", email, password });
  return { api, controller, credentials, last: () => states.at(-1), states };
}

function fail(state) {
  if (state.error) throw new Error(state.error);
}

const workspace = join(OUT, "workspace");
mkdirSync(workspace, { recursive: true });
const { cpSync } = await import("node:fs");
cpSync(join(HERE, "fixture"), workspace, { recursive: true });
writeFileSync(join(workspace, "CLAUDE.md"), "# Shop backend\n\nExisting project notes.\n");

const bob = await sidebar("bob", null);
const alice = await sidebar("alice", workspace);
let teamId;

try {
  // Bob creates the team, so he is the lead and questions route to him.
  await bob.controller.handle({ type: "createTeam", name: "Setup e2e", displayName: "Bob" });
  fail(bob.last());
  teamId = bob.last().team.id;

  await alice.controller.handle({ type: "joinTeam", code: bob.last().team.invite_code, displayName: "Alice" });
  fail(alice.last());
  check("Alice's folder starts unconnected", alice.last().workspace === "not_connected");
  await alice.controller.handle({ type: "connectWorkspace" });
  fail(alice.last());
  check("Alice's folder is connected", alice.last().workspace === "connected");
  check("Existing CLAUDE.md content is kept", readFileSync(join(workspace, "CLAUDE.md"), "utf8").startsWith("# Shop backend"));

  const mcpFile = join(workspace, ".mcp.json");
  const mcp = JSON.parse(readFileSync(mcpFile, "utf8"));
  check("Setup wrote no secret", !JSON.stringify(mcp).includes(SUPABASE_SECRET_KEY));
  mcp.mcpServers.hacky.args = mcp.mcpServers.hacky.args.map((arg) =>
    arg === "hacky-mcp-server" ? `--package=${resolve(args.tarball)}` : arg,
  );
  mcp.mcpServers.hacky.args.push("hacky-mcp-server");
  writeFileSync(mcpFile, JSON.stringify(mcp, null, 2));

  const answering = (async () => {
    for (;;) {
      await bob.controller.refresh();
      const question = bob.last().inbox[0];
      if (question?.waiting >= 1) {
        await new Promise((wake) => setTimeout(wake, ANSWER_AFTER_MS));
        await bob.controller.handle({ type: "answer", questionId: question.id, text: ANSWER });
        fail(bob.last());
        return question;
      }
      await new Promise((wake) => setTimeout(wake, 2000));
    }
  })();

  // The secret key and database password stay out of the agent's environment. The credentials
  // path stands in for each user's ~/.hacky/credentials.json.
  const { SUPABASE_SECRET_KEY: _secret, SUPABASE_DB_PASSWORD: _password, ...env } = process.env;
  const output = await new Promise((done) => {
    const child = spawn(
      CLAUDE_BIN,
      [
        "-p", "Add a discount for loyalty members to cartTotal in src/pricing.js.",
        "--model", "claude-sonnet-5-5",
        "--output-format", "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--setting-sources", "project,local",
        "--permission-mode", "acceptEdits",
        "--max-budget-usd", "0.75",
      ],
      { cwd: workspace, env: { ...env, HACKY_CREDENTIALS_FILE: alice.credentials }, stdio: ["ignore", "pipe", "inherit"] },
    );
    let text = "";
    child.stdout.on("data", (chunk) => (text += chunk));
    child.on("close", () => done(text));
  });
  writeFileSync(join(OUT, "transcript.jsonl"), output);
  const events = output.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const init = events.find((event) => event.type === "system" && event.subtype === "init");
  const result = events.findLast((event) => event.type === "result");
  const toolCalls = events
    .filter((event) => event.type === "assistant")
    .flatMap((event) => event.message.content)
    .filter((block) => block.type === "tool_use")
    .map((block) => block.name);
  console.log(`Tools: ${toolCalls.join(", ")}`);
  console.log(`Permission denials: ${JSON.stringify(result?.permission_denials ?? [])}`);

  // npx is slow to start, so this is often still "pending" when the session begins.
  const hackyStatus = init?.mcp_servers?.find((server) => server.name === "hacky")?.status;
  console.log(`Server status at session start: ${hackyStatus}`);
  check("The agent called get_context", toolCalls.includes("mcp__hacky__get_context"));
  check("The agent called ask", toolCalls.includes("mcp__hacky__ask"));
  check("No Hacky tool needed a permission prompt", !(result?.permission_denials ?? []).some((denial) => denial.tool_name?.startsWith("mcp__hacky")));

  const question = await Promise.race([answering, new Promise((wake) => setTimeout(() => wake(null), 1000))]);
  check("The question reached the teammate's inbox", question !== null, question?.text);
  check("It was marked for the lead, with one agent waiting", question?.routed_to_me === true && question?.waiting === 1);
  check("The agent applied the inbox answer", /\b17\b|0?\.17\b|0?\.83\b/.test(readFileSync(join(workspace, "src/pricing.js"), "utf8")));

  await bob.controller.refresh();
  check("The inbox is empty again", bob.last().inbox.length === 0);
  check("The agent's progress shows in the teammate's feed", bob.last().feed.some((item) => item.author === "Alice"), bob.last().feed[0]?.summary);
  console.log(`\nFinal message:\n${result?.result}\n\nreported cost: $${(result?.total_cost_usd ?? 0).toFixed(2)}`);
} finally {
  bob.controller.dispose();
  alice.controller.dispose();
  await bob.api.dispose();
  await alice.api.dispose();
  if (teamId) await admin.from("teams").delete().eq("id", teamId);
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
}
console.log(`\n${checks.filter(Boolean).length}/${checks.length} checks passed`);
process.exit(checks.every(Boolean) ? 0 : 1);
