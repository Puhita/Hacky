// Sessions bar: when one person's chat ends half done, does their next real chat pick the work up
// from Hacky alone? Each round is one person with two real Claude Code sessions in one folder:
// "first" does half of a task and is told a fact (the agreed rate) that exists nowhere else; it
// is not told to leave a handoff, so the CLAUDE.md block has to make it do that. "next" starts
// afterwards with only "continue my earlier chat's work", so the only place it can learn the
// rate is Hacky. The rate isn't a team decision, so search_decisions can't supply it either.
// Pass, set before measuring:
// - In at least 2 of 3 rounds the first chat leaves a handoff that contains the rate (otherwise
//   the harness never tested the next chat, and the miss is reported as the first chat's).
// - In every such round the next chat calls resume_session, is resumed without `takeover`
//   (the earlier chat had ended), never calls ask, and ends with the rate in the code.
// The first chat leaving the discount unapplied is checked, so a pass can't come from chat one.
// Revised after the first 3-round batch, which read NOT MET under the bar above: the rate was
// searched for in the code, and the first chat's comment "the 17% discount comes in a follow-up"
// counted as an applied discount, so only 1 round was usable. Comments are now stripped before
// the code is checked, and the rate may arrive in the handoff or in the focus, since
// resume_session returns both and a chat that put it in log_progress's `next` shows up there.
// Run from the repo root: node --env-file=.env spike/compliance/resume-sessions.mjs --out <dir> [--rounds N]
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
const TASK = "Add a loyalty discount to cartTotal";
const RATE = /\b17\b|0?\.17\b|0?\.83\b/;
// A comment about the rate isn't the rate being applied.
const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const applied = (code) => RATE.test(stripComments(code));
const PROMPTS = {
  first:
    "Work on the loyalty discount task from the team board, but only the first half: add an optional isLoyaltyMember argument to cartTotal in src/pricing.js and do NOT apply any discount yet. The team has agreed loyalty members get 17% off the whole cart, and a later chat will apply it.",
  next: "Continue the work my earlier chat on this project started.",
};

const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY, CLAUDE_BIN } = process.env;
const { values: args } = parseArgs({ options: { out: { type: "string" }, rounds: { type: "string" } } });
const OUT = resolve(args.out);
const ROUNDS = Number(args.rounds ?? 3);
mkdirSync(OUT, { recursive: true });
const admin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

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

function makeWorkspace(dir, teamId, user) {
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
  return { workspace, mcpConfig, code: () => readFileSync(join(workspace, "src/pricing.js"), "utf8") };
}

function runChat(name, dir, { workspace, mcpConfig }) {
  const cliArgs = [
    "-p", PROMPTS[name],
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
  return new Promise((done) => {
    const child = spawn(CLAUDE_BIN, cliArgs, { cwd: workspace, env, stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => child.kill(), SESSION_TIMEOUT_MS);
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.on("close", () => {
      clearTimeout(timer);
      writeFileSync(join(dir, `${name}-transcript.jsonl`), output);
      const events = output.split("\n").filter(Boolean).flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
      const result = events.findLast((event) => event.type === "result");
      const calls = events
        .filter((event) => event.type === "assistant")
        .flatMap((event) => event.message.content)
        .filter((block) => block.type === "tool_use")
        .map((block) => ({ name: block.name.replace("mcp__hacky__", ""), input: block.input }));
      done({ calls, tools: calls.map((call) => call.name), cost: result?.total_cost_usd ?? 0, finalText: result?.result ?? "(no final message)" });
    });
  });
}

async function runRound(round) {
  const person = await createUser(`person-${round}`);
  const { data: team, error } = await person.supabase.rpc("create_team", { team_name: `Resume ${round}`, member_name: "Person" });
  if (error) throw error;
  try {
    const seeded = await person.supabase.from("tasks").insert({ team_id: team.id, title: TASK, files: ["src/pricing.js"] });
    if (seeded.error) throw seeded.error;

    const roundDir = join(OUT, `round-${round}`);
    mkdirSync(roundDir, { recursive: true });
    const workspace = makeWorkspace(roundDir, team.id, person);

    const first = await runChat("first", roundDir, workspace);
    const afterFirst = workspace.code();
    const { data: firstSessions } = await admin.from("agent_sessions").select("id, handoff, focus, closed_at").eq("team_id", team.id);
    const handoff = firstSessions?.find((session) => session.handoff)?.handoff ?? "";
    // What resume_session will hand over: the notes, and the focus from log_progress.
    const carried = firstSessions?.map((session) => `${session.handoff ?? ""} ${session.focus ?? ""}`).join(" ") ?? "";

    const next = await runChat("next", roundDir, workspace);
    const { data: sessions } = await admin.from("agent_sessions").select("id, closed_at, resumed_by").eq("team_id", team.id);
    const resumeCalls = next.calls.filter((call) => call.name === "resume_session");

    const row = {
      round,
      firstLeftHandoff: handoff !== "",
      handoffHasRate: RATE.test(carried),
      firstLeftDiscountUnapplied: !applied(afterFirst),
      firstEnded: Boolean(firstSessions?.length) && firstSessions.every((session) => session.closed_at !== null),
      nextResumed: resumeCalls.length > 0,
      nextNeededTakeover: resumeCalls.some((call) => call.input.takeover === true),
      recordedTakeover: Boolean(sessions?.some((session) => session.resumed_by !== null)),
      nextAsked: next.tools.includes("ask") || next.tools.includes("ask_teammate"),
      rateInFinalCode: applied(workspace.code()),
      cost: first.cost + next.cost,
      firstTools: first.tools.join(" "),
      nextTools: next.tools.join(" "),
      handoff,
    };
    console.log(
      `round ${round}: handoff=${row.firstLeftHandoff} rate in handoff=${row.handoffHasRate} unapplied after first=${row.firstLeftDiscountUnapplied} first ended=${row.firstEnded} | resumed=${row.nextResumed} takeover=${row.nextNeededTakeover} recorded=${row.recordedTakeover} asked=${row.nextAsked} rate in code=${row.rateInFinalCode}\n  first: ${row.firstTools}\n  next:  ${row.nextTools}`,
    );
    return row;
  } finally {
    await admin.from("teams").delete().eq("id", team.id);
    await admin.auth.admin.deleteUser(person.userId);
  }
}

const rows = await Promise.all(Array.from({ length: ROUNDS }, (_, index) => runRound(index)));
writeFileSync(join(OUT, "results.json"), JSON.stringify(rows, null, 2));
const count = (key) => rows.filter((row) => row[key]).length;
for (const key of ["firstLeftHandoff", "handoffHasRate" /* rate in handoff or focus */, "firstLeftDiscountUnapplied", "firstEnded", "nextResumed", "nextNeededTakeover", "recordedTakeover", "nextAsked", "rateInFinalCode"]) {
  console.log(`${key}: ${count(key)}/${rows.length}`);
}
console.log(`reported cost: $${rows.reduce((sum, row) => sum + row.cost, 0).toFixed(2)}`);

const usable = rows.filter((row) => row.handoffHasRate && row.firstLeftDiscountUnapplied);
const good = (row) => row.nextResumed && !row.nextNeededTakeover && !row.nextAsked && row.rateInFinalCode;
const passed = usable.length * 3 >= rows.length * 2 && usable.length > 0 && usable.every(good);
console.log(`rounds that tested the next chat: ${usable.length}/${rows.length}; of those, resumed and applied the rate: ${usable.filter(good).length}`);
console.log(passed ? "BAR MET" : "BAR NOT MET");
process.exit(passed ? 0 : 1);
