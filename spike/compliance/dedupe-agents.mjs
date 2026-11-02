// Step 4 bar: can real agents tell a true duplicate from a similar but different question?
// For each holdout pair, a teammate has already asked the first question, and a real Claude Code
// session needs the second. Scored from the database: a merge is a waiter row on the teammate's
// question. A human answers whichever question the agent ends up waiting on, so sessions finish.
// Pass: 0 wrong merges on near misses, and at least 50% of paraphrases merged.
// Run from the repo root: node --env-file=.env spike/compliance/dedupe-agents.mjs --out <dir> [--limit N]
// Needs CLAUDE_BIN set to the Claude Code executable, and the server and extension tests built.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { fileStorage } from "../../packages/mcp-server/dist/credentials.js";
import { MANAGED_BLOCK } from "../../packages/extension/out/setup.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, "../../packages/mcp-server/dist/index.js");
const MODEL = "claude-sonnet-5-5";
const CONCURRENCY = 4;
const SESSION_TIMEOUT_MS = 5 * 60_000;
const ANSWER = "The team has decided: use whatever the existing default is.";

const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY, CLAUDE_BIN } = process.env;
const { values: args } = parseArgs({ options: { out: { type: "string" }, limit: { type: "string" } } });
const OUT = resolve(args.out);
mkdirSync(OUT, { recursive: true });
const admin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const pairs = JSON.parse(readFileSync(resolve(HERE, "../../supabase/tests/dedupe-pairs.json"), "utf8"));
const holdout = (list) => list.filter((_, index) => index % 2 === 1).slice(0, args.limit ? Number(args.limit) : undefined);
const cases = [
  ...holdout(pairs.paraphrases).map(([first, second]) => ({ kind: "paraphrase", first, second })),
  ...holdout(pairs.near_misses).map(([first, second]) => ({ kind: "near_miss", first, second })),
];

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
  return { supabase, userId: created.data.user.id, credentials };
}

function runSession(dir, teamId, user, prompt) {
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
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
    "-p", prompt,
    "--model", MODEL,
    "--output-format", "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--setting-sources", "project,local",
    "--mcp-config", mcpConfig,
    "--strict-mcp-config",
    "--permission-mode", "acceptEdits",
    "--allowedTools", "mcp__hacky",
    "--max-budget-usd", "0.30",
  ];
  // The secret key stays out of the agent's environment.
  const { SUPABASE_SECRET_KEY: _secret, SUPABASE_DB_PASSWORD: _password, ...env } = process.env;
  return new Promise((done) => {
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
      const toolCalls = events
        .filter((event) => event.type === "assistant")
        .flatMap((event) => event.message.content)
        .filter((block) => block.type === "tool_use")
        .map((block) => block.name.replace("mcp__hacky__", ""));
      const result = events.findLast((event) => event.type === "result");
      done({
        toolCalls,
        sawCandidates: output.includes("possible_duplicates\\\""),
        finalText: result?.result ?? "",
        cost: result?.total_cost_usd ?? 0,
      });
    });
  });
}

async function seedQuestion(teammate, teamId, text) {
  const { data: embedded, error: embedError } = await teammate.supabase.functions.invoke("embed", { body: { text } });
  if (embedError) throw embedError;
  const { data, error } = await teammate.supabase.rpc("ask_question", {
    target_team: teamId,
    question_text: text,
    question_context: "Working on this feature for the team",
    question_embedding: JSON.stringify(embedded.embedding),
    target_routed_to: teammate.userId,
    candidate_threshold: 1,
    confirmed_new: true,
  });
  if (error) throw error;
  return data.question_id;
}

// Plays the human: once the agent is waiting on a question, answers it so the session can end.
function answerWhenAsked(teammate, agent, teamId, firstId, isDone) {
  const seen = { joined: false, newQuestions: 0 };
  const watching = (async () => {
    let answered = false;
    while (!isDone()) {
      const { data: waiter } = await admin.from("question_waiters").select("user_id").eq("question_id", firstId).eq("user_id", agent.userId);
      const { data: asked } = await admin.from("questions").select("id").eq("team_id", teamId).eq("asked_by", agent.userId);
      seen.joined ||= waiter.length > 0;
      seen.newQuestions = Math.max(seen.newQuestions, asked.length);
      if (!answered && (seen.joined || asked.length > 0)) {
        answered = true;
        const target = seen.joined ? firstId : asked[0].id;
        const { error } = await teammate.supabase.rpc("answer_question", { target_question: target, answer: ANSWER });
        if (error) throw error;
      }
      await new Promise((wake) => setTimeout(wake, 1500));
    }
  })();
  return { seen, watching };
}

async function runCase(entry, index, teammate, agent) {
  const dir = join(OUT, `case-${index}`);
  mkdirSync(dir, { recursive: true });
  const { data: team, error } = await teammate.supabase.rpc("create_team", { team_name: `Dedupe ${index}`, member_name: "Teammate" });
  if (error) throw error;
  try {
    const joined = await agent.supabase.rpc("join_team", { code: team.invite_code, member_name: "Agent" });
    if (joined.error) throw joined.error;
    const firstId = await seedQuestion(teammate, team.id, entry.first);

    let done = false;
    const { seen, watching } = answerWhenAsked(teammate, agent, team.id, firstId, () => done);
    const run = await runSession(
      dir,
      team.id,
      agent,
      `You're about to build a feature that can't be written until this is settled: "${entry.second}" The answer isn't in this repo. Find out the answer, then reply with it in one sentence. Don't write any code.`,
    );
    done = true;
    await watching;

    const merged = seen.joined;
    const outcome = merged && seen.newQuestions > 0 ? "both" : merged ? "merged" : seen.newQuestions > 0 ? "separate" : "never_asked";
    const row = { ...entry, outcome, sawCandidates: run.sawCandidates, tools: run.toolCalls.join(" "), cost: run.cost, finalText: run.finalText };
    console.log(`${entry.kind.padEnd(10)} ${outcome.padEnd(11)} candidates=${String(run.sawCandidates).padEnd(5)} ${entry.first} | ${entry.second}`);
    return row;
  } finally {
    await admin.from("teams").delete().eq("id", team.id);
  }
}

const teammate = await createUser("teammate");
const agent = await createUser("agent");
const rows = [];
try {
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < cases.length) {
        const index = next++;
        rows.push(await runCase(cases[index], index, teammate, agent));
      }
    }),
  );
} finally {
  writeFileSync(join(OUT, "results.json"), JSON.stringify(rows, null, 2));
  await admin.auth.admin.deleteUser(teammate.userId);
  await admin.auth.admin.deleteUser(agent.userId);
}

const count = (kind, ...outcomes) => rows.filter((row) => row.kind === kind && outcomes.includes(row.outcome)).length;
const paraphrases = rows.filter((row) => row.kind === "paraphrase").length;
const nearMisses = rows.filter((row) => row.kind === "near_miss").length;
const wrongMerges = count("near_miss", "merged", "both");
const mergedParaphrases = count("paraphrase", "merged");
const neverAsked = rows.filter((row) => row.outcome === "never_asked").length;

console.log(`\nparaphrases merged: ${mergedParaphrases}/${paraphrases}`);
console.log(`wrong merges: ${wrongMerges}/${nearMisses}`);
console.log(`sessions that never asked or joined: ${neverAsked}`);
console.log(`reported cost: $${rows.reduce((sum, row) => sum + row.cost, 0).toFixed(2)}`);
const passed = wrongMerges === 0 && mergedParaphrases * 2 >= paraphrases;
console.log(passed ? "BAR MET" : "BAR NOT MET");
process.exit(passed ? 0 : 1);
