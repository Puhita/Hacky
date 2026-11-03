// Runs the real sidebar script in a simulated browser.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const SCRIPT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../media/sidebar.js"), "utf8");

function mount() {
  const sent: any[] = [];
  const dom = new JSDOM('<!DOCTYPE html><div id="root"></div>', { runScripts: "outside-only" });
  const window = dom.window as any;
  // Serialized, as a real webview's postMessage does.
  let saved: unknown;
  window.acquireVsCodeApi = () => ({
    postMessage: (message: unknown) => sent.push(JSON.parse(JSON.stringify(message))),
    getState: () => saved,
    setState: (value: unknown) => (saved = JSON.parse(JSON.stringify(value))),
  });
  window.eval(SCRIPT);
  const send = (state: unknown) =>
    window.dispatchEvent(new window.MessageEvent("message", { data: state }));
  const root = window.document.getElementById("root");
  const button = (text: string) =>
    [...root.querySelectorAll("button")].find((node: any) => node.textContent === text) as any;
  return { sent, send, window, root, button };
}

const SIGNED_OUT = {
  user: null,
  teams: [],
  team: null,
  workspace: "none",
  inbox: [],
  assumptions: [],
  decisions: [],
  tasks: [],
  feed: [],
  pulse: [],
  agentChat: [],
  notice: null,
  error: null,
};
const ASSUMPTION = { id: "a1", text: "10% off", created_at: "2026-11-02T10:00:00Z", question: "What discount?", author: "Bob" };
const DECISION = { id: "d1", text: "17% off", created_at: "2026-11-02T10:00:00Z", question: "What discount?", author: "Alice" };
const TEAM = { id: "t1", name: "Team One", invite_code: "abc123", role: "lead" };
const QUESTION = {
  id: "q1",
  text: "What discount?",
  context: "Pricing work",
  created_at: "2026-11-02T10:00:00Z",
  asked_by_name: "Bob",
  routed_to_me: true,
  waiting: 2,
};
const IN_TEAM = { ...SIGNED_OUT, user: { email: "a@example.com" }, teams: [TEAM], team: TEAM, workspace: "not_connected" };

test("asks the extension for state on load", () => {
  assert.deepEqual(mount().sent, [{ type: "ready" }]);
});

test("logging in sends the typed values, and empty fields send nothing", () => {
  const { sent, send, root, button, window } = mount();
  send(SIGNED_OUT);
  const type = (name: string, value: string) => {
    const input = root.querySelector(`[name="${name}"]`);
    input.value = value;
    input.dispatchEvent(new window.Event("input"));
  };
  button("Log in to Hacky").click();
  assert.equal(sent.length, 1, "empty fields send nothing");
  type("email", "a@example.com");
  type("password", "secret");
  button("Log in to Hacky").click();
  assert.deepEqual(sent[1], { type: "signIn", email: "a@example.com", password: "secret" });

  // Signing up is the other tab of the same form, and keeps what was typed.
  button("Sign up").click();
  assert.equal(root.querySelector('[name="email"]').value, "a@example.com");
  assert.equal(button("Log in to Hacky"), undefined);
  button("Create account").click();
  assert.deepEqual(sent[2], { type: "signUp", email: "a@example.com", password: "secret" });
});

test("the password can be shown and hidden", () => {
  const { send, root, button } = mount();
  send(SIGNED_OUT);
  const password = root.querySelector('[name="password"]');
  assert.equal(password.type, "password");
  button("Show").click();
  assert.equal(password.type, "text");
  button("Hide").click();
  assert.equal(password.type, "password");
});

test("shows team choices when signed in without a team", () => {
  const { sent, send, root, button } = mount();
  send({ ...SIGNED_OUT, user: { email: "a@example.com" }, teams: [TEAM] });
  button("Team One").click();
  assert.deepEqual(sent[1], { type: "selectTeam", teamId: "t1" });
  root.querySelector('[name="code"]').value = "abc123";
  const joinName = [...root.querySelectorAll('[name="displayName"]')].at(-1) as any;
  joinName.value = "Alice";
  button("Join team").click();
  assert.deepEqual(sent[2], { type: "joinTeam", code: "abc123", displayName: "Alice" });
});

test("shows the inbox and sends an answer", () => {
  const { sent, send, root, button } = mount();
  send({ ...IN_TEAM, inbox: [QUESTION] });
  assert.match(root.textContent, /What discount\?/);
  assert.match(root.textContent, /From Bob\. 2 agents waiting\./);
  assert.match(root.textContent, /For you/);
  button("Send answer").click();
  assert.equal(sent.length, 1, "an empty answer isn't sent");
  root.querySelector("textarea").value = "17%";
  button("Send answer").click();
  assert.deepEqual(sent[1], { type: "answer", questionId: "q1", text: "17%" });
});

test("teammate and agent text can't inject HTML", () => {
  const attack = '<img src=x onerror="window.hacked=true"><script>window.hacked=true</script>';
  const { send, root, window } = mount();
  send({
    ...IN_TEAM,
    team: { ...TEAM, name: attack },
    inbox: [{ ...QUESTION, text: attack, context: attack, asked_by_name: attack }],
    assumptions: [{ ...ASSUMPTION, text: attack, question: attack, author: attack }],
    decisions: [{ ...DECISION, text: attack, question: attack, author: attack }],
    tasks: [{ id: "t1", title: attack, status: "todo", files: [attack], owner: attack }],
    feed: [{ id: "e1", summary: attack, files: [attack], created_at: "2026-11-02T10:00:00Z", author: attack }],
    error: attack,
  });
  assert.equal(root.querySelectorAll("img, script").length, 0);
  assert.equal(window.hacked, undefined);
  assert.ok(root.textContent.includes("<img src=x"));
});

test("a background refresh keeps a half-typed answer and its focus", () => {
  const { send, root, window } = mount();
  send({ ...IN_TEAM, inbox: [QUESTION] });
  const answer = root.querySelector("textarea");
  answer.value = "half typed";
  answer.dispatchEvent(new window.Event("input"));
  answer.focus();
  send({ ...IN_TEAM, inbox: [{ ...QUESTION, waiting: 3 }] });
  const after = root.querySelector("textarea");
  assert.equal(after.value, "half typed");
  assert.equal(window.document.activeElement, after);
  assert.match(root.textContent, /3 agents waiting/);
});

test("a background refresh keeps half-typed login fields", () => {
  const { send, root, window } = mount();
  send(SIGNED_OUT);
  const email = root.querySelector('[name="email"]');
  email.value = "half@";
  email.focus();
  send(SIGNED_OUT);
  assert.equal(root.querySelector('[name="email"]').value, "half@");
  assert.equal(window.document.activeElement, root.querySelector('[name="email"]'));
});

test("an error is shown even while a field has focus", () => {
  const { send, root } = mount();
  send(SIGNED_OUT);
  root.querySelector('[name="password"]').focus();
  send({ ...SIGNED_OUT, error: "Invalid login credentials" });
  assert.match(root.querySelector('[role="alert"]').textContent, /Invalid login credentials/);
});

test("the connect button shows what will be written, and goes away once connected", () => {
  const { sent, send, root, button } = mount();
  send(IN_TEAM);
  assert.match(root.textContent, /\.mcp\.json/);
  button("Connect this folder").click();
  assert.deepEqual(sent[1], { type: "connectWorkspace" });
  send({ ...IN_TEAM, workspace: "connected" });
  assert.equal(button("Connect this folder"), undefined);
  assert.match(root.textContent, /This folder is connected\./);
});

test("an out-of-date folder offers Update setup, which sends the same connect message", () => {
  const { sent, send, root, button } = mount();
  send({ ...IN_TEAM, workspace: "outdated" });
  assert.match(root.textContent, /older version/);
  assert.match(root.textContent, /hacky:start/);
  assert.equal(button("Connect this folder"), undefined);
  button("Update setup").click();
  assert.deepEqual(sent.at(-1), { type: "connectWorkspace" });
  send({ ...IN_TEAM, workspace: "connected" });
  assert.equal(button("Update setup"), undefined);
  assert.match(root.textContent, /This folder is connected\./);
});

test("an assumption can be confirmed, or rejected with a reason", () => {
  const { sent, send, root, button } = mount();
  send({ ...IN_TEAM, assumptions: [ASSUMPTION] });
  assert.match(root.textContent, /Assumptions\s*1/);
  assert.match(root.textContent, /10% off/);
  assert.match(root.textContent, /Assumed by Bob, for: What discount\?/);
  button("Confirm").click();
  assert.deepEqual(sent[1], { type: "confirmAssumption", assumptionId: "a1" });

  button("Reject").click();
  assert.equal(sent.length, 2, "a rejection needs a reason");
  root.querySelector("#reason-a1").value = "It's 17%";
  button("Reject").click();
  assert.deepEqual(sent[2], { type: "rejectAssumption", assumptionId: "a1", reason: "It's 17%" });
});

test("a decision can be replaced or withdrawn, and its controls stay open through a refresh", () => {
  const { sent, send, root, button, window } = mount();
  send({ ...IN_TEAM, decisions: [DECISION] });
  assert.match(root.textContent, /Decisions\s*1/);
  assert.match(root.textContent, /Decided by Alice\./);
  const details = root.querySelector("details.actions");
  assert.equal(details.open, false, "collapsed, since these notify the whole team");

  details.open = true;
  details.dispatchEvent(new window.Event("toggle"));
  const area = root.querySelector("#decision-d1");
  area.value = "half typed";
  area.dispatchEvent(new window.Event("input"));
  send({ ...IN_TEAM, decisions: [DECISION] });
  assert.equal(root.querySelector("details.actions").open, true);
  assert.equal(root.querySelector("#decision-d1").value, "half typed");

  root.querySelector("#decision-d1").value = "20% off";
  button("Replace").click();
  assert.deepEqual(sent[1], { type: "changeDecision", decisionId: "d1", text: "20% off" });
  button("Withdraw").click();
  assert.deepEqual(sent[2], { type: "withdrawDecision", decisionId: "d1" });
});

test("every section and card can be folded, and each fold keeps its own choice", () => {
  const { send, root, window } = mount();
  const state = { ...IN_TEAM, inbox: [QUESTION], assumptions: [ASSUMPTION], decisions: [DECISION] };
  send(state);
  const folds = () => [...root.querySelectorAll("details.section-fold, details.card-fold")] as any[];
  const named = (title: string) => folds().find((node) => node.textContent.startsWith(title));
  assert.ok(folds().length >= 8, "each section and each card has a fold");
  assert.equal(root.querySelector("details.section-fold").parentElement.className, "panel", "a section is one boxed fold");

  assert.equal(named("Inbox").open, true, "a section with something waiting starts open");
  assert.equal(named("Agent questions").open, false, "an empty section starts folded");
  assert.equal(named("Decisions").open, false, "settled decisions start folded");
  assert.equal(named("Live feed").open, false, "the feed starts folded");
  assert.match(named("Inbox").querySelector(".count").textContent, /^1$/, "the count is a badge on the title");
  assert.equal(root.querySelector(".card-title").textContent, "What discount?", "a card's headline is on its summary line");

  named("Inbox").open = false;
  named("Inbox").dispatchEvent(new window.Event("toggle"));
  send(state);
  assert.equal(named("Inbox").open, false, "a folded section stays folded through a refresh");
  assert.equal(named("Assumptions").open, true, "the other sections are untouched");
});

test("the sidebar has buttons for the board and the map", () => {
  const { sent, send, button } = mount();
  send(IN_TEAM);
  button("Open board").click();
  button("Open team map").click();
  assert.deepEqual(sent.slice(1), [{ type: "openBoard" }, { type: "openMap" }]);
});

test("the task board groups tasks by status, and a task can be added", () => {
  const { sent, send, root, button } = mount();
  send({
    ...IN_TEAM,
    tasks: [
      { id: "1", title: "Plan it", status: "todo", files: [], owner: null },
      { id: "2", title: "Build it", status: "in_progress", files: ["src/a.ts"], owner: "Bob" },
      { id: "3", title: "Ship it", status: "done", files: [], owner: "Alice" },
    ],
  });
  const columns = [...root.querySelectorAll(".task-column")].map((column: any) => column.textContent);
  assert.match(columns[0], /To do \(1\)Plan it/);
  assert.match(columns[1], /In progress \(1\)Build itBob · src\/a\.ts/);
  assert.match(columns[2], /Done \(1\)Ship itAlice/);

  button("Add task").click();
  assert.equal(sent.length, 1, "an empty task isn't sent");
  root.querySelector('[name="title"]').value = "New one";
  button("Add task").click();
  assert.deepEqual(sent[1], { type: "addTask", title: "New one" });
});

test("the feed shows who did what", () => {
  const { send, root } = mount();
  send({ ...IN_TEAM, feed: [{ id: "e1", summary: "Fixed average", files: ["src/math.js"], created_at: "2026-11-02T10:00:00Z", author: "Bob" }] });
  assert.match(root.textContent, /Fixed average/);
  assert.match(root.textContent, /Bob/);
  assert.match(root.textContent, /src\/math\.js/);
});

const INCOMING = {
  id: "p1",
  direction: "incoming",
  other: "Orlin",
  question: "Which fields does /users return?",
  context: "Building the profile page",
  answer: null,
  answered_by_agent: false,
  created_at: "2026-11-02T10:00:00Z",
};

test("a teammate's agent question can be answered from the sidebar, and answered ones are read-only", () => {
  const { sent, send, root, button } = mount();
  send({
    ...IN_TEAM,
    agentChat: [
      INCOMING,
      { ...INCOMING, id: "p2", direction: "outgoing", question: "Is the DB seeded?", answer: "Yes", answered_by_agent: true },
      { ...INCOMING, id: "p3", direction: "outgoing", question: "Who owns auth?" },
    ],
  });
  assert.match(root.textContent, /Agent questions\s*1/);
  assert.match(root.textContent, /Orlin's agent asks/);
  assert.match(root.textContent, /Which fields does \/users return\?/);
  assert.match(root.textContent, /Your agent asked Orlin/);
  assert.match(root.textContent, /Answered by their agent\./);
  assert.match(root.textContent, /Waiting for Orlin\./);
  assert.equal(root.querySelectorAll("textarea").length, 1, "only the open question sent to this person has an answer box");

  button("Send answer to agent").click();
  assert.equal(sent.length, 1, "an empty answer isn't sent");
  root.querySelector("#peer-p1").value = "id, name, email";
  button("Send answer to agent").click();
  assert.deepEqual(sent[1], { type: "answerTeammate", questionId: "p1", text: "id, name, email" });
});

test("the team pulse shows live chats, what they are doing, and recent progress", () => {
  const { send, root } = mount();
  send({
    ...IN_TEAM,
    pulse: [
      { name: "Alice", me: true, chats: 2, focus: ["Login form"], updates: 0, latest: [] },
      { name: "Orlin", me: false, chats: 0, focus: [], updates: 3, latest: ["Finished the users API"] },
    ],
  });
  assert.match(root.textContent, /Alice \(you\)/);
  assert.match(root.textContent, /2 chats active/);
  assert.match(root.textContent, /Now: Login form/);
  assert.match(root.textContent, /No chat active/);
  assert.match(root.textContent, /3 updates in the last hour/);
  assert.match(root.textContent, /Finished the users API/);
});
