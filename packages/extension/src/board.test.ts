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
  project: { overview: { idea: "", architecture: "", updatedBy: null, updatedAt: null }, items: [] },
  fileTouches: [],
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

test("shows seven tabs with counts of what needs attention", () => {
  const { send, root } = mount();
  send(STATE);
  const tabs = [...root.querySelectorAll('[role="tab"]')].map((node: any) => node.textContent);
  assert.deepEqual(tabs, ["Tasks2", "Sprints", "Messages3", "Team", "Project", "Files", "Activity"]);
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

const ITEM = { id: "i1", kind: "bug", title: "Login fails", details: "On Safari only", severity: "high", status: "open", author: "Bob", taskId: null, createdAt: "2026-11-11T08:00:00Z" };
const PROJECT = {
  overview: { idea: "A shared brain", architecture: "MCP server plus Supabase", updatedBy: "Alice", updatedAt: "2026-11-11T08:00:00Z" },
  items: [
    ITEM,
    { ...ITEM, id: "i2", kind: "idea", title: "Dark mode", details: "", severity: null, author: null },
    { ...ITEM, id: "i3", title: "Old bug", status: "done", taskId: "t9" },
  ],
};

test("the Project tab shows the overview and the open ideas and bugs, with a badge for open bugs", () => {
  const { send, root, click } = mount();
  send({ ...STATE, project: PROJECT });
  assert.equal([...root.querySelectorAll('[role="tab"]')].find((node: any) => node.textContent.startsWith("Project")).textContent, "Project1");
  click("Project");
  assert.equal(root.querySelector("#ov-idea").value, "A shared brain");
  assert.equal(root.querySelector("#ov-architecture").value, "MCP server plus Supabase");
  assert.match(root.querySelector(".ov").textContent, /Last edited by Alice/);
  const titles = [...root.querySelectorAll(".pitem .hl")].map((node: any) => node.textContent);
  assert.deepEqual(titles, ["Dark mode", "Login fails"], "ideas first, finished items hidden");
  assert.match(root.querySelector(".sev-high").textContent, /high/);
  click("Show finished (1)");
  assert.equal(root.querySelectorAll(".pitem.closed").length, 1);
  assert.match(root.querySelector(".pitem.closed").textContent, /On the board/);
});

test("the overview is saved as typed, and unsaved text survives a refresh", () => {
  const { sent, send, root, click, window } = mount();
  send({ ...STATE, project: PROJECT });
  click("Project");
  root.querySelector("#ov-idea").value = "A shared brain for teams";
  root.querySelector("#ov-idea").dispatchEvent(new window.Event("input"));
  send({ ...STATE, project: PROJECT, notice: "x" });
  assert.equal(root.querySelector("#ov-idea").value, "A shared brain for teams");
  click("Save overview");
  assert.deepEqual(sent.at(-1), { type: "saveOverview", idea: "A shared brain for teams", architecture: "MCP server plus Supabase" });
});

test("ideas and bugs are added, closed and turned into tasks from the Project tab", () => {
  const { sent, send, root, click } = mount();
  send({ ...STATE, project: PROJECT });
  click("Project");
  click("Add bug");
  assert.equal(sent.length, 1, "an empty title sends nothing");
  root.querySelector("#new-bug").value = "Crash on save";
  root.querySelector("#new-bug-details").value = "Every time";
  root.querySelector('[name="severity"]').value = "medium";
  click("Add bug");
  assert.deepEqual(sent.at(-1), { type: "addProjectItem", kind: "bug", title: "Crash on save", details: "Every time", severity: "medium" });
  root.querySelector("#new-idea").value = "Export";
  click("Add idea");
  assert.deepEqual(sent.at(-1), { type: "addProjectItem", kind: "idea", title: "Export", details: "" });

  const bug = [...root.querySelectorAll(".pitem")].find((node: any) => node.textContent.includes("Login fails")) as any;
  const press = (text: string) => [...bug.querySelectorAll("button")].find((node: any) => node.textContent === text).click();
  press("Make task");
  assert.deepEqual(sent.at(-1), { type: "projectItemToTask", itemId: "i1" });
  press("Done");
  assert.deepEqual(sent.at(-1), { type: "setProjectItemStatus", itemId: "i1", status: "done" });
  press("Drop");
  assert.deepEqual(sent.at(-1), { type: "setProjectItemStatus", itemId: "i1", status: "dropped" });
});

test("what teammates and agents filed is shown as text, never as HTML", () => {
  const { send, root, click } = mount();
  const evil = '<img src=x onerror="alert(1)">';
  send({ ...STATE, project: { overview: { idea: evil, architecture: evil, updatedBy: evil, updatedAt: "2026-11-11T08:00:00Z" }, items: [{ ...ITEM, title: evil, details: evil, author: evil }] } });
  click("Project");
  assert.equal(root.querySelectorAll("img").length, 0);
  assert.ok(root.querySelector(".pitem .hl").textContent.includes("<img"));
});

const NOW_ISO = new Date().toISOString();
const TOUCHES = [
  { path: "src/app.ts", person: "Alice", touches: 3, lastAt: NOW_ISO },
  { path: "src/app.ts", person: "Bob", touches: 1, lastAt: NOW_ISO },
  { path: "src/ui/panel.ts", person: "Bob", touches: 2, lastAt: NOW_ISO },
  { path: "README.md", person: "Alice", touches: 1, lastAt: NOW_ISO },
];

test("the Files tab shows a folder tree of reported edits with who touched each file", () => {
  const { send, root, click } = mount();
  send({ ...STATE, fileTouches: TOUCHES });
  click("Files");
  const names = () => [...root.querySelectorAll(".frow .fname")].map((node: any) => node.textContent);
  assert.deepEqual(names(), ["src/", "ui/", "app.ts", "README.md"], "top folders start open, deeper ones closed, folders first");
  const src = root.querySelector(".frow.folder") as any;
  assert.equal(src.getAttribute("aria-expanded"), "true");
  assert.match(src.querySelector(".stack").getAttribute("aria-label"), /Alice/);
  assert.match(src.querySelector(".stack").getAttribute("aria-label"), /Bob/);

  const ui = [...root.querySelectorAll(".frow.folder")].find((node: any) => node.textContent.includes("ui/")) as any;
  ui.click();
  assert.deepEqual(names(), ["src/", "ui/", "panel.ts", "app.ts", "README.md"]);
  (root.querySelector(".frow.folder") as any).click();
  assert.deepEqual(names(), ["src/", "README.md"], "a folder folds away");
  (root.querySelector(".frow.folder") as any).click();
  const app = [...root.querySelectorAll(".frow.file")].find((node: any) => node.textContent.includes("app.ts")) as any;
  assert.equal(app.querySelectorAll(".av").length, 2, "one avatar per person");
  assert.match(app.querySelector(".stack").getAttribute("aria-label"), /Touched by .*Alice/);
});

test("the Files tab can be narrowed to one person, and explains an empty tree", () => {
  const { send, root, click } = mount();
  send({ ...STATE, fileTouches: [] });
  click("Files");
  assert.match(root.querySelector(".empty").textContent, /Connect this folder/);

  send({ ...STATE, fileTouches: TOUCHES });
  const chips = () => [...root.querySelectorAll('[aria-label="Filter files by person"] .chip')].map((node: any) => node.textContent);
  assert.deepEqual(chips(), ["Everyone4", "Alice2", "Bob2"]);
  click("Alice");
  assert.deepEqual([...root.querySelectorAll(".frow .fname")].map((node: any) => node.textContent), ["src/", "app.ts", "README.md"]);
  click("Bob");
  assert.deepEqual([...root.querySelectorAll(".frow .fname")].map((node: any) => node.textContent), ["src/", "ui/", "app.ts"]);
});

test("file names are shown as text, never as HTML", () => {
  const { send, root, click } = mount();
  const evil = '<img src=x onerror="alert(1)">';
  send({ ...STATE, fileTouches: [{ path: `a/${evil}.ts`, person: evil, touches: 1, lastAt: NOW_ISO }] });
  click("Files");
  assert.equal(root.querySelectorAll("img").length, 0);
  assert.ok([...root.querySelectorAll(".fname")].some((node: any) => node.textContent.includes("<img")));
});

const SPRINT = { id: "s1", name: "Sprint 1", goal: "Login works", startsOn: "2026-11-10", endsOn: "2099-11-24", status: "active", createdBy: "Alice", startedAt: "2026-11-10T08:00:00Z", closedAt: null, record: null, createdAt: "2026-11-09T08:00:00Z" };
const SPRINT_TASKS = [
  { id: "1", title: "Plan it", status: "todo", files: [], owner: null, sprintId: null },
  { id: "2", title: "Build it", status: "in_progress", files: [], owner: "Bob", sprintId: "s1" },
  { id: "3", title: "Ship it", status: "done", files: [], owner: "Alice", sprintId: "s1" },
];
const SPRINTS = [
  SPRINT,
  { ...SPRINT, id: "s2", name: "Sprint 2", goal: "", status: "planned", startsOn: null, endsOn: null, startedAt: null },
  {
    ...SPRINT,
    id: "s0",
    name: "Sprint 0",
    status: "closed",
    endsOn: "2026-11-09",
    closedAt: "2026-11-09T18:00:00Z",
    record: {
      done: [{ id: "9", title: "Set up repo", owner: "Alice", area: "code" }],
      unfinished: [{ id: "8", title: "Write docs", owner: null, area: null, status: "in_progress" }],
      progress: [{ summary: "Repo is up", author: "Alice", at: "2026-11-09T12:00:00Z", task: "Set up repo" }],
    },
  },
];

test("the Sprints tab shows the running sprint with its progress, the planned ones and the backlog", () => {
  const { send, root, click } = mount();
  send({ ...STATE, tasks: SPRINT_TASKS, sprints: SPRINTS });
  const tab = [...root.querySelectorAll('[role="tab"]')].find((node: any) => node.textContent.startsWith("Sprints")) as any;
  assert.equal(tab.textContent, "Sprints1", "one unfinished task in the running sprint");
  click("Sprints");
  const running = root.querySelector(".sprint");
  assert.match(running.textContent, /Sprint 1/);
  assert.match(running.textContent, /Login works/);
  assert.match(running.textContent, /1 of 2 tasks done/);
  assert.match(running.textContent, /days left/);
  assert.equal(running.querySelector('[role="progressbar"]').getAttribute("aria-valuenow"), "1");
  assert.match(root.textContent, /Planned/);
  assert.match(root.textContent, /Close the running sprint to start this one/);
  const backlog = [...root.querySelectorAll(".grp")].find((node: any) => node.textContent.startsWith("Backlog")) as any;
  assert.deepEqual([...backlog.querySelectorAll(".srow .grow")].map((node: any) => node.textContent), ["Plan it"]);
});

test("sprints are planned, filled, started and closed from the Sprints tab", () => {
  const { sent, send, root, click, window } = mount();
  send({ ...STATE, tasks: SPRINT_TASKS, sprints: SPRINTS });
  click("Sprints");
  click("Plan sprint");
  assert.equal(sent.length, 1, "a sprint needs a name");
  root.querySelector("#sprint-name").value = "Sprint 3";
  root.querySelector("#sprint-start").value = "2026-12-01";
  root.querySelector("#sprint-end").value = "2026-12-14";
  root.querySelector("#sprint-goal").value = "Payments";
  click("Plan sprint");
  assert.deepEqual(sent.at(-1), { type: "addSprint", name: "Sprint 3", goal: "Payments", startsOn: "2026-12-01", endsOn: "2026-12-14" });

  const move = root.querySelector('[aria-label="Add to sprint: Plan it"]');
  move.value = "s2";
  move.dispatchEvent(new window.Event("change"));
  assert.deepEqual(sent.at(-1), { type: "setTaskSprint", taskId: "1", sprintId: "s2" });

  const running = root.querySelector(".sprint");
  [...running.querySelectorAll("button")].find((node: any) => node.textContent === "Remove").click();
  assert.deepEqual(sent.at(-1), { type: "setTaskSprint", taskId: "2", sprintId: null });

  click("Close sprint");
  assert.deepEqual(sent.at(-1), { type: "closeSprint", sprintId: "s1" });
  root.querySelector("#carry-to").value = "s2";
  click("Close sprint");
  assert.deepEqual(sent.at(-1), { type: "closeSprint", sprintId: "s1", carryTo: "s2" });

  click("Delete sprint");
  assert.deepEqual(sent.at(-1), { type: "deleteSprint", sprintId: "s2" });

  send({ ...STATE, tasks: SPRINT_TASKS, sprints: SPRINTS.filter((sprint) => sprint.status !== "active") });
  click("Start sprint");
  assert.deepEqual(sent.at(-1), { type: "startSprint", sprintId: "s2" });
});

test("a past sprint shows what was done, what wasn't, and the progress logged", () => {
  const { send, root, click } = mount();
  send({ ...STATE, tasks: SPRINT_TASKS, sprints: SPRINTS });
  click("Sprints");
  click("Sprint 0");
  const past = [...root.querySelectorAll(".card")].find((node: any) => node.textContent.includes("Sprint 0")) as any;
  assert.match(past.textContent, /1 of 2 tasks done/);
  assert.match(past.textContent, /Done \(1\)Set up repo/);
  assert.match(past.textContent, /Not finished \(1\)Write docs/);
  assert.match(past.textContent, /in progress/);
  assert.match(past.textContent, /Alice Repo is up/);
});

test("the Tasks tab labels tasks with their sprint and can add a task straight into one", () => {
  const { sent, send, root, click } = mount();
  send({ ...STATE, tasks: SPRINT_TASKS, sprints: SPRINTS });
  assert.deepEqual([...root.querySelectorAll(".stag")].map((node: any) => node.textContent), ["Sprint 1", "Sprint 1"]);
  root.querySelector("#new-task").value = "Fix login";
  root.querySelector("#new-task-sprint").value = "s1";
  click("Add task");
  assert.deepEqual(sent.at(-1), { type: "addTask", title: "Fix login", sprintId: "s1" });
});

test("without sprints the Tasks tab has no sprint picker and the Sprints tab invites planning one", () => {
  const { send, root, click } = mount();
  send(STATE);
  assert.equal(root.querySelector("#new-task-sprint"), null);
  click("Sprints");
  assert.match(root.textContent, /No finished sprints yet/);
  assert.equal(root.querySelector(".sprint"), null);
});

test("sprint names and records from teammates are shown as text, never as HTML", () => {
  const { send, root, click } = mount();
  const evil = '<img src=x onerror="alert(1)">';
  const record = { done: [{ id: "9", title: evil, owner: evil, area: null }], unfinished: [], progress: [{ summary: evil, author: evil, at: "2026-11-09T12:00:00Z", task: evil }] };
  send({ ...STATE, tasks: SPRINT_TASKS, sprints: [{ ...SPRINT, name: evil, goal: evil }, { ...SPRINTS[2], name: evil, goal: evil, record }] });
  click("Sprints");
  click("<img");
  assert.equal(root.querySelectorAll("img").length, 0);
  assert.ok(root.querySelector(".sprint h2").textContent.includes("<img"));
});
