import assert from "node:assert/strict";
import { test } from "node:test";
import { attentionCount, statusText } from "./attention.js";

const question = (routed_to_me: boolean) => ({ id: "q", text: "?", context: null, created_at: "", asked_by_name: "Bob", routed_to_me, waiting: 1 });
const thread = (direction: "incoming" | "outgoing", answer: string | null) =>
  ({ id: "t", direction, other: "Bob", question: "?", context: null, answer, answered_by_agent: false, created_at: "" }) as const;

test("only questions addressed to the person, and unanswered incoming agent questions, count", () => {
  assert.equal(attentionCount({ inbox: [], agentChat: [] }), 0);
  assert.equal(
    attentionCount({
      inbox: [question(true), question(false)],
      agentChat: [thread("incoming", null), thread("incoming", "Done"), thread("outgoing", null)],
    }),
    2,
  );
});

test("the status bar says how many need the person", () => {
  assert.equal(statusText(0), "Hacky · all clear");
  assert.equal(statusText(3), "Hacky · 3 need you");
});
