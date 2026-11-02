// Stub Hacky MCP server for the compliance spike. Every question gets the same
// canned answer, released on the second check_answers call after it was asked,
// or once HACKY_SPIKE_ANSWER_DELAY_MS has passed if that is set.
import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const LOG = process.env.HACKY_SPIKE_LOG;
const ANSWER = process.env.HACKY_SPIKE_ANSWER;
const ANSWER_DELAY_MS = Number(process.env.HACKY_SPIKE_ANSWER_DELAY_MS ?? 0);
const CHECKS_UNTIL_ANSWERED = 2;
const MAX_WAIT_SECONDS = 240;

const log = (event) => appendFileSync(LOG, JSON.stringify({ at: Date.now(), ...event }) + "\n");
const reply = (body) => ({ content: [{ type: "text", text: JSON.stringify(body) }] });

const pending = new Map();
let nextId = 1;

function collectAnswers() {
  const answers = [];
  const stillPending = [];
  for (const [id, question] of pending) {
    question.checks++;
    const ready = ANSWER_DELAY_MS
      ? Date.now() - question.askedAt >= ANSWER_DELAY_MS
      : question.checks >= CHECKS_UNTIL_ANSWERED;
    if (ready) {
      answers.push({ question_id: id, answer: ANSWER });
      pending.delete(id);
    } else {
      stillPending.push(id);
    }
  }
  return { answers, stillPending };
}

const server = new McpServer({ name: "hacky", version: "0.0.0-spike" });

server.registerTool(
  "ask",
  {
    description:
      "Ask your team a question that only a human can answer, such as a product decision, a business rule, or a fact not in the code. The question is sent to the right teammate, and the answer is shared with every agent waiting on it. Returns a question id; collect the answer with check_answers.",
    inputSchema: {
      question: z.string().describe("The question, answerable without seeing your session"),
      context: z.string().describe("What you are working on and why you need this"),
      assumption: z
        .string()
        .optional()
        .describe("What you will assume in the meantime, if the work can continue without the answer"),
    },
  },
  async ({ question, context, assumption }) => {
    const id = `q${nextId++}`;
    pending.set(id, { checks: 0, askedAt: Date.now() });
    log({ tool: "ask", id, question, context, assumption });
    return reply({ status: "pending", question_id: id, message: "Sent to your team. Call check_answers for the reply." });
  },
);

server.registerTool(
  "check_answers",
  {
    description:
      "Get answers to the questions you asked with ask, and list the ones still pending. Pass wait_seconds to hold the call open until an answer arrives or the time runs out. Waiting uses no tokens.",
    inputSchema: {
      wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional().describe("How long to wait for an answer"),
    },
  },
  async ({ wait_seconds = 0 }) => {
    const startedAt = Date.now();
    const deadline = startedAt + wait_seconds * 1000;
    let result = collectAnswers();
    while (result.answers.length === 0 && result.stillPending.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      result = collectAnswers();
    }
    const { answers, stillPending } = result;
    log({
      tool: "check_answers",
      wait_seconds,
      waitedMs: Date.now() - startedAt,
      answered: answers.map((a) => a.question_id),
      stillPending,
    });
    return reply({ answers, still_pending: stillPending });
  },
);

await server.connect(new StdioServerTransport());
