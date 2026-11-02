// Runs fresh Claude Code sessions against the stub server and scores them.
// Usage: node run.mjs --out <dir> [--reps 2] [--conditions a,b] [--scenarios a,b] [--concurrency 4]
// Needs CLAUDE_BIN set to the Claude Code executable.
import { spawn } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = "claude-sonnet-5-5";
const BUDGET_PER_RUN_USD = "0.50";
const TIMEOUT_MS = 5 * 60 * 1000;

const SCENARIOS = {
  discount: {
    prompt: "Add a discount for loyalty members to cartTotal in src/pricing.js.",
    answer: "Loyalty members get 17% off the cart total.",
    file: "src/pricing.js",
    applied: /\b17\b|0?\.17\b|0?\.83\b/,
  },
  deletion: {
    prompt: "Add a deleteUser function to src/users.js. The team hasn't settled yet what should happen to a deleted user's orders.",
    answer: "Keep the orders and set their userId to null.",
    file: "src/users.js",
    applied: /userId\s*(=|:)\s*null/,
  },
  timeout: {
    prompt: "Add a session timeout to src/config.js, set to what our security review requires.",
    answer: "The security review requires a 37 minute session timeout.",
    file: "src/config.js",
    applied: /\b37\b|\b2220\b|2220000|2_220_000/,
  },
  control: {
    prompt: "Fix the bug in average in src/math.js. It should return the arithmetic mean.",
    answer: "No team preference. Use your judgement.",
    file: "src/math.js",
    applied: /\/\s*\(?\s*values\.length\s*\)?\s*;/,
    isControl: true,
  },
};

const CONDITIONS = {
  tools_only: { block: null, hook: false },
  claude_md: { block: "claude-block.md", hook: false },
  claude_md_hook: { block: "claude-block.md", hook: true },
  claude_md_wait: { block: "claude-block-wait.md", hook: false },
};

const { values: args } = parseArgs({
  options: {
    out: { type: "string" },
    reps: { type: "string", default: "2" },
    conditions: { type: "string", default: Object.keys(CONDITIONS).join(",") },
    scenarios: { type: "string", default: Object.keys(SCENARIOS).join(",") },
    concurrency: { type: "string", default: "4" },
    "answer-delay-ms": { type: "string", default: "0" },
  },
});

const BIN = process.env.CLAUDE_BIN;
if (!BIN || !args.out) {
  console.error("Set CLAUDE_BIN and pass --out <dir>.");
  process.exit(1);
}
const OUT = resolve(args.out);

function prepareWorkspace(runDir, condition, scenario) {
  const workspace = join(runDir, "workspace");
  const logFile = join(runDir, "calls.jsonl");
  cpSync(join(HERE, "fixture"), workspace, { recursive: true });
  writeFileSync(logFile, "");

  if (condition.block) {
    writeFileSync(join(workspace, "CLAUDE.md"), readFileSync(join(HERE, condition.block)));
  }
  if (condition.hook) {
    mkdirSync(join(workspace, ".claude"));
    const command = `"${process.execPath}" "${join(HERE, "session-start-hook.mjs")}"`;
    writeFileSync(
      join(workspace, ".claude", "settings.json"),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } }, null, 2),
    );
  }

  const mcpConfig = join(runDir, "mcp.json");
  writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        hacky: {
          command: process.execPath,
          args: [join(HERE, "server.mjs")],
          env: {
            HACKY_SPIKE_LOG: logFile,
            HACKY_SPIKE_ANSWER: scenario.answer,
            HACKY_SPIKE_ANSWER_DELAY_MS: args["answer-delay-ms"],
          },
        },
      },
    }),
  );
  return { workspace, logFile, mcpConfig };
}

function runSession({ workspace, logFile, mcpConfig }, prompt, transcript) {
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
    "--allowedTools", "mcp__hacky__ask", "mcp__hacky__check_answers",
    "--max-budget-usd", BUDGET_PER_RUN_USD,
  ];
  return new Promise((done) => {
    const child = spawn(BIN, cliArgs, {
      cwd: workspace,
      env: { ...process.env, HACKY_SPIKE_LOG: logFile },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk) => appendFileSync(transcript, chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ exitCode: null, timedOut, stderr: String(error) });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      done({ exitCode, timedOut, stderr });
    });
  });
}

const readJsonLines = (file) =>
  existsSync(file)
    ? readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      })
    : [];

function score(paths, scenario, transcript, session) {
  const calls = readJsonLines(paths.logFile);
  const events = readJsonLines(transcript);
  const result = events.findLast((event) => event.type === "result");
  const toolNames = events
    .filter((event) => event.type === "assistant")
    .flatMap((event) => event.message?.content ?? [])
    .filter((block) => block.type === "tool_use")
    .map((block) => block.name);
  const init = events.find((event) => event.type === "system" && event.subtype === "init");

  const asks = calls.filter((call) => call.tool === "ask").length;
  const checks = calls.filter((call) => call.tool === "check_answers");
  const gotAnswer = checks.some((call) => call.answered.length > 0);
  const code = readFileSync(join(paths.workspace, scenario.file), "utf8");
  const applied = scenario.applied.test(code);

  return {
    hookFired: calls.some((call) => call.hook === "SessionStart"),
    mcpStatus: init?.mcp_servers?.find((server) => server.name === "hacky")?.status ?? "unknown",
    asks,
    checks: checks.length,
    gotAnswer,
    applied,
    askedHuman: toolNames.includes("AskUserQuestion"),
    pass: scenario.isControl ? asks === 0 && applied : asks > 0 && gotAnswer && applied,
    costUsd: result?.total_cost_usd ?? 0,
    turns: result?.num_turns ?? 0,
    endedAs: session.timedOut ? "timeout" : (result?.subtype ?? `exit ${session.exitCode}`),
    stderr: session.stderr.slice(0, 500),
    finalText: (result?.result ?? "").slice(0, 500),
  };
}

const jobs = [];
for (const conditionName of args.conditions.split(",")) {
  for (const scenarioName of args.scenarios.split(",")) {
    for (let rep = 1; rep <= Number(args.reps); rep++) {
      jobs.push({ conditionName, scenarioName, rep });
    }
  }
}

const results = [];
async function worker() {
  for (let job = jobs.shift(); job; job = jobs.shift()) {
    const { conditionName, scenarioName, rep } = job;
    const scenario = SCENARIOS[scenarioName];
    const runDir = join(OUT, `${conditionName}-${scenarioName}-${rep}`);
    mkdirSync(runDir, { recursive: true });
    const paths = prepareWorkspace(runDir, CONDITIONS[conditionName], scenario);
    const transcript = join(runDir, "transcript.jsonl");
    const session = await runSession(paths, scenario.prompt, transcript);
    const row = { condition: conditionName, scenario: scenarioName, rep, ...score(paths, scenario, transcript, session) };
    results.push(row);
    writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
    console.log(
      `${row.pass ? "PASS" : "MISS"} ${conditionName}/${scenarioName}/${rep} asks=${row.asks} checks=${row.checks} applied=${row.applied} askedHuman=${row.askedHuman} ended=${row.endedAs} $${row.costUsd.toFixed(3)}`,
    );
  }
}

await Promise.all(Array.from({ length: Number(args.concurrency) }, worker));

console.log("\ncondition / decision runs passed / control runs passed");
for (const name of args.conditions.split(",")) {
  const rows = results.filter((row) => row.condition === name);
  const decision = rows.filter((row) => row.scenario !== "control");
  const control = rows.filter((row) => row.scenario === "control");
  const passed = (list) => `${list.filter((row) => row.pass).length}/${list.length}`;
  console.log(`${name}: ${passed(decision)} / ${passed(control)}`);
}
const cost = results.reduce((sum, row) => sum + row.costUsd, 0);
console.log(`\ntotal reported cost: $${cost.toFixed(2)} across ${results.length} runs`);
