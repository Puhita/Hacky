// Step 5 bar: when a human rejects an assumption mid-work, do real agents hear about it and fix
// their code? Each round has two real Claude Code sessions needing the same detail. A human
// rejects the first assumption on each question, then answers once the notices are collected.
// Pass, set before measuring: every agent sees the notice, and at least 5 of 6 end up with the
// corrected value in their code. `before answer` shows who fixed it from the notice alone.
// The prompt tells agents not to stop work for the detail, since this tests notices, not whether
// agents choose to declare an assumption.
// Run from the repo root: node --env-file=.env spike/compliance/assumption-sessions.mjs --out <dir> [--rounds N]
// Needs CLAUDE_BIN set to the Claude Code executable, and the server and extension tests built.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { fileStorage } from "../../packages/mcp-server/dist/credentials.js";
import { MANAGED_BLOCK } from "../../packages/extension/out/setup.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, "../../packages/mcp-server/dist/index.js");
const MODEL = "claude-sonnet-5-5";
const SESSION_TIMEOUT_MS = 10 * 60_000;
// How long agents get to declare an assumption, and then to act on the notice alone.
const DECLARE_WINDOW_MS = 150_000;
const NOTICE_WINDOW_MS = 150_000;
const SETTLE_AFTER_NOTICE_MS = 75_000;
const CORRECTION = "Loyalty members get 17% off the cart total.";
const CORRECTED = /\b17\b|0?\.17\b|0?\.83\b/;
const PROMPT =
  "Add a discount for loyalty members to cartTotal in src/pricing.js. Nobody has told you the percentage yet, and it's a detail that is easy to change later, so don't stop work for it.";

const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY, CLAUDE_BIN } = process.env;
const { values: args } = parseArgs({ options: { out: { type: "string" }, rounds: { type: "string" } } });
const OUT = resolve(args.out);
const ROUNDS = Number(args.rounds ?? 3);
mkdirSync(OUT, { recursive: true });
const admin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const sleep = (ms) => new Promise((wake) => setTimeout(wake, ms));

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

function startSession(dir, teamId, user) {
  const workspace = join(dir, "workspace");
  cpSync(join(HERE, "fixture"), workspace, { recursive: true });
  writeFileSync(join(workspace, "CLAUDE.md"), `${MANAGED_BLOCK}\n`);
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
    "-p", PROMPT,
    "--model", MODEL,
    "--output-format", "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--setting-sources", "project,local",
    "--mcp-config", mcpConfig,
    "--strict-mcp-config",
    "--permission-mode", "acceptEdits",
    "--allowedTools", "mcp__hacky",
    "--max-budget-usd", "0.75",
  ];
  // The secret key stays out of the agent's environment.
  const { SUPABASE_SECRET_KEY: _secret, SUPABASE_DB_PASSWORD: _password, ...env } = process.env;
  const finished = new Promise((done) => {
    const child = spawn(CLAUDE_BIN, cliArgs, { cwd: workspace, env, stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => child.kill(), SESSION_TIMEOUT_MS);
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.on("close", () => {
      clearTimeout(timer);
      writeFileSync(join(dir, "transcript.jsonl"), output);
      const events = output.split("\n").filter(Boolean).flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
      const result = events.findLast((event) => event.type === "result");
      done({
        sawNotice: output.includes("assumption_rejected"),
        tools: events
          .filter((event) => event.type === "assistant")
          .flatMap((event) => event.message.content)
          .filter((block) => block.type === "tool_use")
          .map((block) => block.name.replace("mcp__hacky__", ""))
          .join(" "),
        cost: result?.total_cost_usd ?? 0,
        finalText: result?.result ?? "(no final message)",
      });
    });
  });
  return { finished, code: () => readFileSync(join(workspace, "src/pricing.js"), "utf8") };
}

// Plays the human lead.
async function playLead(lead, teamId, agents, sessions, isDone) {
  const beforeAnswer = {};
  const declareDeadline = Date.now() + DECLARE_WINDOW_MS;
  let assumptions = [];
  while (!isDone() && Date.now() < declareDeadline) {
    ({ data: assumptions } = await admin.from("assumptions").select("id, question_id, user_id").eq("team_id", teamId).eq("status", "pending").order("created_at"));
    if (agents.every((agent) => assumptions.some((row) => row.user_id === agent.userId))) break;
    await sleep(2000);
  }

  const rejectedQuestions = new Set();
  for (const assumption of assumptions) {
    if (rejectedQuestions.has(assumption.question_id)) continue;
    rejectedQuestions.add(assumption.question_id);
    const { error } = await lead.supabase.rpc("reject_assumption", { target_assumption: assumption.id, reason: CORRECTION });
    if (error) throw error;
  }

  const noticeDeadline = Date.now() + NOTICE_WINDOW_MS;
  while (!isDone() && Date.now() < noticeDeadline) {
    const { count } = await admin.from("notices").select("*", { count: "exact", head: true }).eq("team_id", teamId);
    if (count === 0) break;
    await sleep(2000);
  }
  // Gives agents time to act on the notice before the answer repeats the value.
  const settle = Date.now() + SETTLE_AFTER_NOTICE_MS;
  while (!isDone() && Date.now() < settle) await sleep(2000);
  agents.forEach((agent, index) => (beforeAnswer[agent.label] = CORRECTED.test(sessions[index].code())));

  const { data: open } = await admin.from("questions").select("id").eq("team_id", teamId).eq("status", "open");
  for (const question of open) {
    const { error } = await lead.supabase.rpc("answer_question", { target_question: question.id, answer: CORRECTION });
    if (error) throw error;
  }
  return beforeAnswer;
}

async function runRound(round) {
  const lead = await createUser(`lead-${round}`);
  const agents = [await createUser(`first-${round}`), await createUser(`second-${round}`)];
  const { data: team, error } = await lead.supabase.rpc("create_team", { team_name: `Assumptions ${round}`, member_name: "Lead" });
  if (error) throw error;
  try {
    for (const agent of agents) {
      const joined = await agent.supabase.rpc("join_team", { code: team.invite_code, member_name: agent.label });
      if (joined.error) throw joined.error;
    }
    const sessions = agents.map((agent) => {
      const dir = join(OUT, agent.label);
      mkdirSync(dir, { recursive: true });
      return startSession(dir, team.id, agent);
    });
    let done = false;
    const leading = playLead(lead, team.id, agents, sessions, () => done);
    const runs = await Promise.all(sessions.map((session) => session.finished));
    done = true;
    const beforeAnswer = await leading;

    const { data: declared } = await admin.from("assumptions").select("user_id").eq("team_id", team.id);
    return agents.map((agent, index) => {
      const row = {
        agent: agent.label,
        declared: declared.some((item) => item.user_id === agent.userId),
        sawNotice: runs[index].sawNotice,
        fixedBeforeAnswer: beforeAnswer[agent.label],
        fixed: CORRECTED.test(sessions[index].code()),
        tools: runs[index].tools,
        cost: runs[index].cost,
        finalText: runs[index].finalText,
      };
      console.log(`${row.agent.padEnd(10)} declared=${row.declared} notice=${row.sawNotice} before answer=${row.fixedBeforeAnswer} final=${row.fixed}  ${row.tools}`);
      return row;
    });
  } finally {
    await admin.from("teams").delete().eq("id", team.id);
    for (const user of [lead, ...agents]) await admin.auth.admin.deleteUser(user.userId);
  }
}

const rows = (await Promise.all(Array.from({ length: ROUNDS }, (_, index) => runRound(index)))).flat();
writeFileSync(join(OUT, "results.json"), JSON.stringify(rows, null, 2));
const count = (key) => rows.filter((row) => row[key]).length;
console.log(`\ndeclared an assumption: ${count("declared")}/${rows.length}`);
console.log(`saw the notice: ${count("sawNotice")}/${rows.length}`);
console.log(`fixed from the notice, before the answer: ${count("fixedBeforeAnswer")}/${rows.length}`);
console.log(`corrected value in final code: ${count("fixed")}/${rows.length}`);
console.log(`reported cost: $${rows.reduce((sum, row) => sum + row.cost, 0).toFixed(2)}`);
const passed = count("sawNotice") === rows.length && count("fixed") * 6 >= rows.length * 5;
console.log(passed ? "BAR MET" : "BAR NOT MET");
process.exit(passed ? 0 : 1);
