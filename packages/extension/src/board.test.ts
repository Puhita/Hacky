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
  assert.match(root.textContent, /17% off/, "decisions sit in the side rail");

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
  click("Open map");
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

test("a decision can be changed or withdrawn from the Board", () => {
  const { sent, send, root, click, window } = mount();
  send(STATE);
  click("Messages");
  click("Change");
  const area = root.querySelector("#decision-d1");
  area.value = "20% off";
  area.dispatchEvent(new window.Event("input"));
  click("Replace");
  assert.deepEqual(sent[1], { type: "changeDecision", decisionId: "d1", text: "20% off" });
  click("Withdraw");
  assert.deepEqual(sent[2], { type: "withdrawDecision", decisionId: "d1" });
});

test("an assumption is rejected with a reason from the Board", () => {
  const { sent, send, root, click } = mount();
  send(STATE);
  click("Messages");
  click("Reject…");
  click("Reject and notify");
  assert.equal(sent.length, 1, "a rejection needs a reason");
  root.querySelector("#reason-a1").value = "It is 17%";
  click("Reject and notify");
  assert.deepEqual(sent[1], { type: "rejectAssumption", assumptionId: "a1", reason: "It is 17%" });
});

test("the Activity tab can be narrowed to one person", () => {
  const { send, root, click } = mount();
  send({
    ...STATE,
    feed: [
      { id: "e1", summary: "Fixed average", files: [], created_at: "2026-11-02T10:00:00Z", author: "Bob" },
      { id: "e2", summary: "Wrote the form", files: [], created_at: "2026-11-02T10:05:00Z", author: "Alice" },
    ],
  });
  click("Activity");
  assert.match(root.textContent, /Fixed average/);
  assert.match(root.textContent, /Wrote the form/);
  click("Bob");
  assert.match(root.textContent, /Fixed average/);
  assert.ok(!root.textContent.includes("Wrote the form"));
  click("Everyone");
  assert.match(root.textContent, /Wrote the form/);
});

test("the Team tab shows a map card with live numbers", () => {
  const { send, root, click } = mount();
  send(STATE);
  click("Team");
  assert.ok(root.querySelector(".hero svg.mini"));
  assert.match(root.querySelector(".stats").textContent, /1working/);
});

test("tasks can be filtered by person", () => {
  const { send, root, click } = mount();
  const pulse = [
    { name: "Alice", me: true, chats: 1, focus: [], updates: 0, latest: [] },
    { name: "Bob", me: false, chats: 0, focus: [], updates: 0, latest: [] },
  ];
  send({ ...STATE, pulse });
  const chips = () => [...root.querySelectorAll('[aria-label="Filter tasks by person"] .chip')].map((node: any) => node.textContent);
  assert.deepEqual(chips(), ["Everyone3", "Alice1", "Bob1"]);
  const shown = () => [...root.querySelectorAll(".tc .hl")].map((node: any) => node.textContent);
  assert.deepEqual(shown(), ["Plan it", "Build it", "Ship it"]);

  click("Bob");
  assert.deepEqual(shown(), ["Build it"]);
  click("Alice");
  assert.deepEqual(shown(), ["Ship it"]);
  click("Everyone");
  assert.deepEqual(shown(), ["Plan it", "Build it", "Ship it"]);
});

test("the task filter is hidden when the team is one person, and the Add task button has an icon", () => {
  const { send, root } = mount();
  send(STATE);
  assert.equal(root.querySelector('[aria-label="Filter tasks by person"]'), null);
  assert.ok(root.querySelector(".addtask .btn.cta svg"));
});

test("a new task can be given an area, and tasks can be filtered by area", () => {
  const { sent, send, root, click } = mount();
  const tasks = [
    { id: "1", title: "Plan it", status: "todo", files: [], area: "design", owner: null },
    { id: "2", title: "Build it", status: "in_progress", files: [], area: "code", owner: "Bob" },
    { id: "3", title: "Ship it", status: "done", files: [], area: null, owner: "Alice" },
  ];
  send({ ...STATE, tasks });
  const areaChips = () => [...root.querySelectorAll('[aria-label="Filter tasks by area"] .chip')].map((node: any) => node.textContent);
  assert.deepEqual(areaChips(), ["All areas3", "art0", "code1", "design1", "audio0"]);
  const shown = () => [...root.querySelectorAll(".tc .hl")].map((node: any) => node.textContent);
  assert.match(root.querySelector(".area-design").textContent, /design/);

  click("code");
  assert.deepEqual(shown(), ["Build it"]);
  click("All areas");
  assert.deepEqual(shown(), ["Plan it", "Build it", "Ship it"]);

  root.querySelector('[name="title"]').value = "Draw hero";
  root.querySelector('[name="area"]').value = "art";
  click("Add task");
  assert.deepEqual(sent[1], { type: "addTask", title: "Draw hero", area: "art" });
});

test("the area filter is hidden until some task has an area, and it survives a refresh", () => {
  const { send, root, click } = mount();
  send(STATE);
  assert.equal(root.querySelector('[aria-label="Filter tasks by area"]'), null);
  const tasks = [{ id: "1", title: "Plan it", status: "todo", files: [], area: "audio", owner: null }, { id: "2", title: "Other", status: "todo", files: [], area: "art", owner: null }];
  send({ ...STATE, tasks });
  click("audio");
  send({ ...STATE, tasks });
  assert.deepEqual([...root.querySelectorAll(".tc .hl")].map((node: any) => node.textContent), ["Plan it"]);
});
