// Step 2 end-to-end check: two real Claude Code sessions as different users, sharing a
// task, a progress log and an answered question through the real server and database.
// Run from the repo root: node --env-file=.env spike/compliance/two-sessions.mjs --out <dir>
// Needs CLAUDE_BIN set to the Claude Code executable, and the server built.
import { spawnSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { fileStorage } from "../../packages/mcp-server/dist/credentials.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, "../../packages/mcp-server/dist/index.js");
const MODEL = "claude-sonnet-5-5";
const ANSWER_AFTER_MS = 45_000;
const ANSWER = "Loyalty members get 17% off the cart total. Pass membership as an isLoyaltyMember argument.";
const TOOLS = ["get_context", "log_progress", "claim_task", "ask", "check_answers"];

const BLOCK = `<!-- hacky:start -->
## Team coordination (Hacky)

You are one of several agents working for a team. The team shares tasks, progress and decisions through the Hacky tools.

- At the start of a session, call \`get_context\`.
- Before working on a task from the team board, call \`claim_task\`. If it says a teammate owns the task, leave it alone.
- When you finish a chunk of work, call \`log_progress\`.
- If a task depends on a product decision, business rule, or fact that isn't in the request or the code, do not guess it and do not ask your own human. Call \`ask\` before writing the code that depends on it.
- After \`ask\`, call \`check_answers\` with \`wait_seconds: 240\`. Your teammates are human and may take several minutes to reply. Waiting uses no tokens. If the answer is still pending, call it again, up to three times, then follow the answer exactly.
- If it is still pending after that, finish what you can and say clearly that the answer is still pending.
- Do not use \`ask\` for things you can work out from the code, or for ordinary engineering choices.
<!-- hacky:end -->
`;

const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY, CLAUDE_BIN } = process.env;
const { values: args } = parseArgs({ options: { out: { type: "string" } } });
const OUT = resolve(args.out);
const adminOptions = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, adminOptions);

async function createUser(label) {
  const email = `hacky-test-${label}-${randomBytes(6).toString("hex")}@example.com`;
  const password = randomBytes(24).toString("hex");
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  const credentials = join(OUT, `${label}-credentials.json`);
  const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { storage: fileStorage(credentials), persistSession: true, autoRefreshToken: false },
  });
  const signedIn = await supabase.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw signedIn.error;
  return { label, supabase, userId: created.data.user.id, credentials };
}

function runSession(user, teamId, prompt) {
  const dir = join(OUT, user.label);
  const workspace = join(dir, "workspace");
  cpSync(join(HERE, "fixture"), workspace, { recursive: true });
  writeFileSync(join(workspace, "CLAUDE.md"), BLOCK);
  const mcpConfig = join(dir, "mcp.json");
  writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        hacky: {
          command: process.execPath,
          args: [SERVER],
          env: {
            HACKY_SUPABASE_URL: SUPABASE_URL,
            HACKY_SUPABASE_PUBLISHABLE_KEY: SUPABASE_PUBLISHABLE_KEY,
            HACKY_TEAM_ID: teamId,
            HACKY_CREDENTIALS_FILE: user.credentials,
          },
        },
      },
    }),
  );
  const cliArgs = [
    "-p", prompt,
    "--model", MODEL,
    "--output-format", "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--setting-sources", "project,local",
    "--mcp-config", mcpConfig,
    "--strict-mcp-config",
    "--permission-mode", "acceptEdits",
    "--allowedTools", ...TOOLS.map((tool) => `mcp__hacky__${tool}`),
    "--max-budget-usd", "0.75",
  ];
  // The secret key stays out of the agent's environment.
  const { SUPABASE_SECRET_KEY: _secret, SUPABASE_DB_PASSWORD: _password, ...env } = process.env;
  return new Promise((done) => {
    const child = spawn(CLAUDE_BIN, cliArgs, { cwd: workspace, env, stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.on("close", () => {
      writeFileSync(join(dir, "transcript.jsonl"), output);
      const events = output.split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const toolCalls = events
        .filter((event) => event.type === "assistant")
        .flatMap((event) => event.message.content)
        .filter((block) => block.type === "tool_use")
        .map((block) => block.name);
      const result = events.findLast((event) => event.type === "result");
      done({ toolCalls, finalText: result?.result ?? "", cost: result?.total_cost_usd ?? 0, workspace, output });
    });
  });
}

// Plays the human teammate: answers the first open question after a realistic delay.
async function answerFirstQuestion(teamId, answerer) {
  for (;;) {
    const { data } = await answerer.supabase.from("questions").select("id, text").eq("team_id", teamId).eq("status", "open").limit(1);
    if (data?.length) {
      await new Promise((wake) => setTimeout(wake, ANSWER_AFTER_MS));
      const decision = await answerer.supabase
        .from("decisions")
        .insert({ team_id: teamId, decided_by: answerer.userId, text: ANSWER })
        .select("id")
        .single();
      if (decision.error) throw decision.error;
      const updated = await answerer.supabase.from("questions").update({ status: "answered", decision_id: decision.data.id }).eq("id", data[0].id);
      if (updated.error) throw updated.error;
      return data[0].text;
    }
    await new Promise((wake) => setTimeout(wake, 2000));
  }
}

const checks = [];
const check = (name, passed, detail = "") => {
  checks.push(passed);
  console.log(`${passed ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

mkdirSync(join(OUT, "bob"), { recursive: true });
mkdirSync(join(OUT, "alice"), { recursive: true });
const alice = await createUser("alice");
const bob = await createUser("bob");
const team = await alice.supabase.rpc("create_team", { team_name: "Two sessions", member_name: "Alice" });
if (team.error) throw team.error;
const teamId = team.data.id;

try {
  const joined = await bob.supabase.rpc("join_team", { code: team.data.invite_code, member_name: "Bob" });
  if (joined.error) throw joined.error;
  const task = await alice.supabase
    .from("tasks")
    .insert({ team_id: teamId, title: "Fix the bug in average in src/math.js. It should return the arithmetic mean." })
    .select("id")
    .single();
  if (task.error) throw task.error;

  const bobRun = await runSession(bob, teamId, "Pick up the next unclaimed task from the team board and finish it.");
  const bobCalls = bobRun.toolCalls.join(", ");
  console.log(`Bob's tools: ${bobCalls}`);
  const { data: taskRow } = await admin.from("tasks").select("owner_id, status").eq("id", task.data.id).single();
  check("Bob's agent called get_context", bobRun.toolCalls.includes("mcp__hacky__get_context"));
  check("Bob's agent claimed the task", taskRow.owner_id === bob.userId, taskRow.status);
  check("Bob's agent fixed the code", /\/\s*\(?\s*values\.length\s*\)?\s*;/.test(readFileSync(join(bobRun.workspace, "src/math.js"), "utf8")));
  const { data: bobEvents } = await admin.from("events").select("summary").eq("team_id", teamId).eq("user_id", bob.userId);
  check("Bob's agent logged progress", bobEvents.length > 0, bobEvents[0]?.summary);

  const answering = answerFirstQuestion(teamId, bob);
  const aliceRun = await runSession(
    alice,
    teamId,
    "Add a discount for loyalty members to cartTotal in src/pricing.js. In your final summary, say what your teammates finished recently.",
  );
  console.log(`Alice's tools: ${aliceRun.toolCalls.join(", ")}`);
  const asked = await Promise.race([answering, new Promise((wake) => setTimeout(() => wake(null), 1000))]);
  check("Alice's agent asked the team", asked !== null, asked ?? "no question was answered");
  check("Alice's agent received Bob's progress", aliceRun.output.includes(bobEvents[0]?.summary?.slice(0, 40).replaceAll('"', '\\"') ?? "(none)"));
  check("Alice's agent held check_answers for the answer", aliceRun.toolCalls.includes("mcp__hacky__check_answers"));
  check("Alice's agent applied the answer", /\b17\b|0?\.17\b|0?\.83\b/.test(readFileSync(join(aliceRun.workspace, "src/pricing.js"), "utf8")));
  console.log(`\nAlice's final message:\n${aliceRun.finalText}\n`);
  console.log(`reported cost: $${(bobRun.cost + aliceRun.cost).toFixed(2)}`);
} finally {
  await admin.from("teams").delete().eq("id", teamId);
  await admin.auth.admin.deleteUser(alice.userId);
  await admin.auth.admin.deleteUser(bob.userId);
}
console.log(`\n${checks.filter(Boolean).length}/${checks.length} checks passed`);
process.exit(checks.every(Boolean) ? 0 : 1);
