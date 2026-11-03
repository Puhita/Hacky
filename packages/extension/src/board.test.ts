// Runs the real Hacky Board script in a simulated browser.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const SCRIPT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../media/board.js"), "utf8");

function mount() {
  const sent: any[] = [];
  const dom = new JSDOM('<!DOCTYPE html><div id="root"></div>', { runScripts: "outside-only" });
  const window = dom.window as any;
  let saved: unknown;
  window.acquireVsCodeApi = () => ({
    postMessage: (message: unknown) => sent.push(JSON.parse(JSON.stringify(message))),
    getState: () => saved,
    setState: (value: unknown) => (saved = JSON.parse(JSON.stringify(value))),
  });
  window.eval(SCRIPT);
  const send = (state: unknown) => window.dispatchEvent(new window.MessageEvent("message", { data: state }));
  const root = window.document.getElementById("root");
  const click = (text: string) => [...root.querySelectorAll("button")].find((node: any) => node.textContent.startsWith(text)).click();
  return { sent, send, root, window, click };
}

const TEAM = { id: "t1", name: "Team One", invite_code: "abc123", role: "lead" };
const STATE = {
  user: { email: "a@example.com" },
  teams: [TEAM],
  team: TEAM,
  workspace: "connected",
  inbox: [
    { id: "q1", text: "What discount?", context: "Pricing", created_at: "2026-11-02T10:00:00Z", asked_by_name: "Bob", routed_to_me: true, waiting: 2 },
    { id: "q2", text: "Which colour?", context: null, created_at: "2026-11-02T10:00:00Z", asked_by_name: "Bob", routed_to_me: false, waiting: 1 },
  ],
  assumptions: [{ id: "a1", text: "10% off", created_at: "2026-11-02T10:00:00Z", question: "What discount?", author: "Bob" }],
  decisions: [{ id: "d1", text: "17% off", created_at: "2026-11-02T10:00:00Z", question: "What discount?", author: "Alice" }],
  tasks: [
    { id: "1", title: "Plan it", status: "todo", files: [], owner: null },
    { id: "2", title: "Build it", status: "in_progress", files: ["src/a.ts"], owner: "Bob" },
    { id: "3", title: "Ship it", status: "done", files: [], owner: "Alice" },
  ],
  feed: [{ id: "e1", summary: "Fixed average", files: ["src/math.js"], created_at: "2026-11-02T10:00:00Z", author: "Bob" }],
  pulse: [{ name: "Alice", me: true, chats: 1, focus: ["Login form"], updates: 2, latest: ["Finished the API"] }],
  agentChat: [
    { id: "p1", direction: "incoming", other: "Bob", question: "Which fields?", context: null, answer: null, answered_by_agent: false, created_at: "2026-11-02T10:00:00Z" },
  ],
  map: {
    project: "Team One",
    owners: [{ id: "u1", name: "Alice", me: true }],
    chats: [
      { id: "c1", ownerId: "u1", state: "active", focus: "Wiring the form", task: null, lastProgressAt: null, lastSeenAt: "2026-11-02T10:00:00Z", startedAt: "2026-11-02T10:00:00Z", resumedFrom: null },
    ],
    threads: [],
  },
  notice: null,
  error: null,
};

test("asks the extension for state on load", () => {
  assert.deepEqual(mount().sent, [{ type: "ready" }]);
});

test("asks to log in before there is a team to show", () => {
  const { send, root } = mount();
  send({ ...STATE, user: null, team: null });
  assert.match(root.textContent, /Log in and choose a team/);
  assert.equal(root.querySelectorAll("button").length, 0);
});

test("shows four tabs with counts of what needs attention", () => {
  const { send, root } = mount();
  send(STATE);
  const tabs = [...root.querySelectorAll('[role="tab"]')].map((node: any) => node.textContent);
  assert.deepEqual(tabs, ["Tasks2", "Messages3", "Team", "Activity"]);
});

test("the Tasks tab groups tasks by status, and adds a task", () => {
  const { sent, send, root, click } = mount();
  send(STATE);
  const columns = [...root.querySelectorAll(".column")].map((node: any) => node.textContent);
  assert.match(columns[0], /To do/);
  assert.match(columns[0], /Plan it/);
  assert.match(columns[1], /Build it/);
  assert.match(columns[1], /Bob/);
  assert.match(columns[2], /Ship it/);

  click("Add task");
  assert.equal(sent.length, 1, "an empty title sends nothing");
  root.querySelector('[name="title"]').value = "New one";
  click("Add task");
  assert.deepEqual(sent[1], { type: "addTask", title: "New one" });
});

test("the Messages tab shows what needs the person first, and can show everything", () => {
  const { sent, send, root, click, window } = mount();
  send(STATE);
  click("Messages");
  assert.match(root.textContent, /What discount\?/);
  assert.ok(!root.textContent.includes("Which colour?"), "a team question for someone else is hidden under Needs me");
  assert.match(root.textContent, /Which fields\?/);
  assert.ok(!root.textContent.includes("17% off"), "decisions are only under Everything");

  root.querySelector("#answer-q1").value = "17%";
  root.querySelector("#answer-q1").dispatchEvent(new window.Event("input"));
  click("Send answer");
  assert.deepEqual(sent[1], { type: "answer", questionId: "q1", text: "17%" });

  root.querySelector("#peer-p1").value = "id, name";
  root.querySelector("#peer-p1").dispatchEvent(new window.Event("input"));
  click("Send answer to agent");
  assert.deepEqual(sent[2], { type: "answerTeammate", questionId: "p1", text: "id, name" });

  click("Confirm");
  assert.deepEqual(sent[3], { type: "confirmAssumption", assumptionId: "a1" });

  click("Everything");
  assert.match(root.textContent, /Which colour\?/);
  assert.match(root.textContent, /17% off/);
});

test("the Team tab shows people with their chats, and opens the map", () => {
  const { sent, send, root, click } = mount();
  send(STATE);
  click("Team");
  assert.match(root.textContent, /Alice \(you\)/);
  assert.match(root.textContent, /1 chat active/);
  assert.match(root.textContent, /Wiring the form/);
  assert.match(root.textContent, /Finished the API/);
  click("Open animated map");
  assert.deepEqual(sent[1], { type: "openMap" });
});

test("the Activity tab lists the feed", () => {
  const { send, root, click } = mount();
  send(STATE);
  click("Activity");
  assert.match(root.textContent, /Fixed average/);
  assert.match(root.textContent, /src\/math\.js/);
});

test("the chosen tab survives a refresh and what teammates wrote is never run as HTML", () => {
  const { send, root, click } = mount();
  send(STATE);
  click("Activity");
  const attack = '<img src=x onerror="alert(1)">';
  send({ ...STATE, feed: [{ id: "e1", summary: attack, files: [attack], created_at: "2026-11-02T10:00:00Z", author: attack }] });
  assert.match(root.querySelector('[aria-selected="true"]').textContent, /Activity/);
  assert.equal(root.querySelectorAll("img, script").length, 0);
  assert.ok(root.textContent.includes("<img src=x"));
});

test("a refresh waits while the person is typing, and half-typed text survives it", async () => {
  const { send, root, window, click } = mount();
  send(STATE);
  click("Messages");
  const area = root.querySelector("#answer-q1");
  area.value = "half typed";
  area.dispatchEvent(new window.Event("input"));
  area.focus();
  send({ ...STATE, inbox: [{ ...STATE.inbox[0], waiting: 3 }, STATE.inbox[1]] });
  assert.equal(root.querySelector("#answer-q1"), area, "the box is left alone while it has focus");
  area.blur();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(root.textContent, /3 agents waiting/);
  assert.equal(root.querySelector("#answer-q1").value, "half typed");
});
