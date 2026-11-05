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
  // A button is found by its text, or by its label when it is an icon.
  const button = (text: string) =>
    [...root.querySelectorAll("button")].find((node: any) => node.textContent === text || node.getAttribute("aria-label") === text) as any;
  // The sidebar has three views, switched with the tabs.
  const goTo = (label: string) =>
    ([...root.querySelectorAll(".tab")] as any[]).find((tab) => tab.querySelector(".lbl").textContent === label).click();
  return { sent, send, window, root, button, goTo };
}

const SIGNED_OUT = {
  user: null,
  teams: [],
  team: null,
  members: [],
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
const TEAM = { id: "t1", name: "Team One", invite_code: "abc123", role: "lead", members: 2 };
const MEMBERS = [
  { id: "u1", name: "Alice", role: "lead", me: true },
  { id: "u2", name: "Bob", role: "member", me: false },
];
const QUESTION = {
  id: "q1",
  text: "What discount?",
  context: "Pricing work",
  created_at: "2026-11-02T10:00:00Z",
  asked_by_name: "Bob",
  routed_to_me: true,
  waiting: 2,
};
const IN_TEAM = { ...SIGNED_OUT, user: { email: "a@example.com", displayName: "Alice" }, teams: [TEAM], team: TEAM, members: MEMBERS, workspace: "not_connected" };
const AS_MEMBER = { ...IN_TEAM, team: { ...TEAM, role: "member" }, members: [{ ...MEMBERS[0], role: "member" }, { ...MEMBERS[1], role: "lead", me: false }] };

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

  // Signing up is the same form, and keeps what was typed.
  button("Sign up").click();
  assert.equal(root.querySelector('[name="email"]').value, "a@example.com");
  assert.equal(button("Log in to Hacky"), undefined);
  // Signing up asks for the password twice. Nothing is sent until both agree.
  assert.ok(root.querySelector('[name="confirm"]'), "a repeat-password box appears");
  button("Create account").click();
  assert.equal(sent.length, 2, "an empty repeat sends nothing");
  assert.match(root.querySelector("#auth-error").textContent, /Repeat the password/);
  const repeat = root.querySelector('[name="confirm"]');
  repeat.value = "secrex";
  repeat.dispatchEvent(new window.Event("input"));
  assert.equal(root.querySelector("#auth-error"), null, "typing clears the message");
  button("Create account").click();
  assert.equal(sent.length, 2);
  assert.match(root.querySelector("#auth-error").textContent, /don't match/);
  const again = root.querySelector('[name="confirm"]');
  again.value = "secret";
  again.dispatchEvent(new window.Event("input"));
  button("Create account").click();
  assert.deepEqual(sent[2], { type: "signUp", email: "a@example.com", password: "secret", confirmPassword: "secret" });
  // Logging in has no repeat box.
  button("Log in").click();
  assert.equal(root.querySelector('[name="confirm"]'), null);
});

test("showing the password on the sign-up form shows the repeat box too", () => {
  const { send, root, button } = mount();
  send(SIGNED_OUT);
  button("Sign up").click();
  button("Show password").click();
  assert.equal(root.querySelector('[name="password"]').type, "text");
  assert.equal(root.querySelector('[name="confirm"]').type, "text");
});

test("the password can be shown and hidden", () => {
  const { send, root, button } = mount();
  send(SIGNED_OUT);
  const password = root.querySelector('[name="password"]');
  assert.equal(password.type, "password");
  button("Show password").click();
  assert.equal(password.type, "text");
  button("Hide password").click();
  assert.equal(password.type, "password");
});

test("shows team choices when signed in without a team", () => {
  const { sent, send, root, button } = mount();
  send({ ...SIGNED_OUT, user: { email: "a@example.com" }, teams: [TEAM] });
  button("Team One").click();
  assert.deepEqual(sent[1], { type: "selectTeam", teamId: "t1" });
  root.querySelector('[name="code"]').value = "abc123";
  const names = [...root.querySelectorAll('[name="displayName"]')] as any[];
  names[0].value = "Alice";
  button("Join team").click();
  assert.deepEqual(sent[2], { type: "joinTeam", code: "abc123", displayName: "Alice" });
  root.querySelector('[name="name"]').value = "New team";
  names[1].value = "Alice";
  button("Create team").click();
  assert.deepEqual(sent[3], { type: "createTeam", name: "New team", displayName: "Alice" });
});

test("shows the inbox and sends an answer", () => {
  const { sent, send, root, button } = mount();
  send({ ...IN_TEAM, inbox: [QUESTION] });
  assert.match(root.textContent, /What discount\?/);
  assert.match(root.textContent, /Bob/);
  assert.match(root.textContent, /2 agents waiting/);
  assert.match(root.textContent, /For you/);
  button("Send answer").click();
  assert.equal(sent.length, 1, "an empty answer isn't sent");
  root.querySelector("textarea").value = "17%";
  button("Send answer").click();
  assert.deepEqual(sent[1], { type: "answer", questionId: "q1", text: "17%" });
});

test("the status strip and the tab count what needs the person", () => {
  const { send, root } = mount();
  send({
    ...IN_TEAM,
    inbox: [QUESTION, { ...QUESTION, id: "q2", waiting: 1 }],
    pulse: [{ name: "Alice", me: true, chats: 2, focus: [], updates: 0, latest: [] }],
  });
  const tiles = [...root.querySelectorAll(".tile")].map((tile: any) => tile.textContent);
  assert.deepEqual(tiles, ["2need you", "2working", "3waiting"]);
  assert.ok(root.querySelector(".tile.hot"), "the need-you tile stands out");
  assert.equal(root.querySelector(".tab.on .lbl").textContent, "Needs you");
});

test("with nothing waiting the Needs you view says all clear", () => {
  const { sent, send, root } = mount();
  send(IN_TEAM);
  assert.match(root.textContent, /No open questions\. All clear\./);
  assert.equal(root.querySelector(".tile.hot"), null);
  (root.querySelector(".empty .btn") as any).click();
  assert.deepEqual(sent[1], { type: "openBoard" });
});

test("teammate and agent text can't inject HTML", () => {
  const attack = '<img src=x onerror="window.hacked=true"><script>window.hacked=true</script>';
  const { send, root, window, goTo } = mount();
  send({
    ...IN_TEAM,
    team: { ...TEAM, name: attack },
    inbox: [{ ...QUESTION, text: attack, context: attack, asked_by_name: attack }],
    assumptions: [{ ...ASSUMPTION, text: attack, question: attack, author: attack }],
    decisions: [{ ...DECISION, text: attack, question: attack, author: attack }],
    tasks: [{ id: "t1", title: attack, status: "todo", files: [attack], owner: attack }],
    feed: [{ id: "e1", summary: attack, files: [attack], created_at: "2026-11-02T10:00:00Z", author: attack }],
    pulse: [{ name: attack, me: false, chats: 1, focus: [attack], updates: 1, latest: [attack] }],
    agentChat: [{ id: "p1", direction: "outgoing", other: attack, question: attack, context: attack, answer: attack, answered_by_agent: false, created_at: "2026-11-02T10:00:00Z" }],
    error: attack,
  });
  for (const label of ["Needs you", "Team", "Tasks"]) {
    goTo(label);
    assert.equal(root.querySelectorAll("img, script").length, 0, label);
  }
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
  assert.match(root.textContent, /Agents are proceeding on\s*1/);
  assert.match(root.textContent, /10% off/);
  assert.match(root.textContent, /Assumed by Bob, for: What discount\?/);
  button("Confirm").click();
  assert.deepEqual(sent[1], { type: "confirmAssumption", assumptionId: "a1" });

  assert.equal(root.querySelector("#reason-a1"), null, "the reason box opens on Reject");
  button("Reject…").click();
  assert.ok(root.querySelector("#reason-a1"));
  button("Reject and notify").click();
  assert.equal(sent.length, 2, "a rejection needs a reason");
  root.querySelector("#reason-a1").value = "It's 17%";
  button("Reject and notify").click();
  assert.deepEqual(sent[2], { type: "rejectAssumption", assumptionId: "a1", reason: "It's 17%" });
});

test("a decision can be replaced or withdrawn, and its change box stays open through a refresh", () => {
  const { sent, send, root, button, goTo, window } = mount();
  send({ ...IN_TEAM, decisions: [DECISION] });
  goTo("Team");
  assert.match(root.textContent, /Decisions\s*1/);
  assert.match(root.textContent, /Decided by Alice\./);
  assert.equal(root.querySelector("#decision-d1"), null, "closed, since these notify the whole team");

  button("Change").click();
  const area = root.querySelector("#decision-d1");
  area.value = "half typed";
  area.dispatchEvent(new window.Event("input"));
  send({ ...IN_TEAM, decisions: [DECISION] });
  assert.equal(root.querySelector("#decision-d1").value, "half typed");

  root.querySelector("#decision-d1").value = "20% off";
  button("Replace").click();
  assert.deepEqual(sent[1], { type: "changeDecision", decisionId: "d1", text: "20% off" });
  button("Withdraw").click();
  assert.deepEqual(sent[2], { type: "withdrawDecision", decisionId: "d1" });
});

test("cards and sections fold, Collapse all and Expand all fold them together, and the choices are remembered", () => {
  const { send, root, button, goTo } = mount();
  const state = { ...IN_TEAM, inbox: [QUESTION], assumptions: [ASSUMPTION] };
  send(state);
  const folds = () => [...root.querySelectorAll(".card-h[aria-expanded], .sec-h[aria-expanded]")] as any[];
  const open = (node: any) => node.getAttribute("aria-expanded") === "true";
  assert.equal(root.querySelector(".card-h .hl").textContent, "What discount?", "a card's headline is on its header");
  assert.equal(open(folds()[0]), true, "a waiting question starts open");

  folds()[0].click();
  assert.equal(open(folds()[0]), false);
  send(state);
  assert.equal(open(folds()[0]), false, "a folded card stays folded through a refresh");

  goTo("Team");
  assert.equal(folds().find((node) => node.textContent.startsWith("Decisions")).getAttribute("aria-expanded"), "false", "settled decisions start folded");
  assert.equal(folds().find((node) => node.textContent.startsWith("Live feed")).getAttribute("aria-expanded"), "false", "the feed starts folded");
  button("Expand all").click();
  assert.ok(folds().every(open));
  button("Collapse all").click();
  assert.ok(folds().every((node) => !open(node)));
  assert.ok(button("Expand all"), "the button flips back");
});

test("the chosen view is remembered", () => {
  const { send, root, goTo } = mount();
  send(IN_TEAM);
  goTo("Tasks");
  assert.equal(root.querySelector(".tab.on .lbl").textContent, "Tasks");
  send({ ...IN_TEAM, workspace: "connected" });
  assert.equal(root.querySelector(".tab.on .lbl").textContent, "Tasks", "a refresh keeps the view");
});

test("the sidebar has buttons for the board and the map", () => {
  const { sent, send, button } = mount();
  send(IN_TEAM);
  button("Open board").click();
  button("Open map").click();
  assert.deepEqual(sent.slice(1), [{ type: "openBoard" }, { type: "openMap" }]);
});

test("the Team view has a Map card with its own Open map button", () => {
  const { sent, send, root, goTo } = mount();
  send({ ...IN_TEAM, pulse: [{ name: "Alice", me: true, chats: 1, focus: ["Login form"], updates: 0, latest: [] }] });
  goTo("Team");
  assert.ok(root.querySelector(".mapcard svg.mini"));
  const open = [...root.querySelectorAll(".mapcard button")].find((node: any) => node.textContent === "Open map") as any;
  open.click();
  assert.deepEqual(sent.at(-1), { type: "openMap" });
});

test("the invite code can be copied", () => {
  const { send, root, button, window } = mount();
  let copied = "";
  Object.defineProperty(window.navigator, "clipboard", { value: { writeText: (text: string) => (copied = text) } });
  send(IN_TEAM);
  assert.match(root.querySelector(".inv").textContent, /abc123/);
  button("Copy invite code").click();
  assert.equal(copied, "abc123");
});

test("the task board groups tasks by status, and a task can be added", () => {
  const { sent, send, root, button, goTo } = mount();
  send({
    ...IN_TEAM,
    tasks: [
      { id: "1", title: "Plan it", status: "todo", files: [], owner: null },
      { id: "2", title: "Build it", status: "in_progress", files: ["src/a.ts"], owner: "Bob" },
      { id: "3", title: "Ship it", status: "done", files: [], owner: "Alice" },
    ],
  });
  goTo("Tasks");
  const columns = [...root.querySelectorAll(".task-column")].map((column: any) => column.textContent);
  assert.match(columns[0], /To do\s*1.*Plan it/);
  assert.match(columns[1], /In progress\s*1.*Build it.*Bob.*src\/a\.ts/);
  assert.match(columns[2], /Done\s*1.*Ship it.*Alice/);

  button("Add task").click();
  assert.equal(sent.length, 1, "an empty task isn't sent");
  root.querySelector('[name="title"]').value = "New one";
  button("Add task").click();
  assert.deepEqual(sent[1], { type: "addTask", title: "New one" });
});

test("the feed shows who did what", () => {
  const { send, root, goTo } = mount();
  send({ ...IN_TEAM, feed: [{ id: "e1", summary: "Fixed average", files: ["src/math.js"], created_at: "2026-11-02T10:00:00Z", author: "Bob" }] });
  goTo("Team");
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
  assert.match(root.textContent, /Orlin's agent asks/);
  assert.match(root.textContent, /Which fields does \/users return\?/);
  assert.match(root.textContent, /Your agent asked Orlin/);
  assert.match(root.textContent, /Answered by their agent\./);
  assert.match(root.textContent, /Waiting for Orlin\./);
  assert.equal(root.querySelectorAll("textarea").length, 1, "only the open question sent to this person has an answer box");
  assert.equal(root.querySelector(".tile.hot .hx b").textContent, "1", "it counts as needing the person");

  button("Send answer to agent").click();
  assert.equal(sent.length, 1, "an empty answer isn't sent");
  root.querySelector("#peer-p1").value = "id, name, email";
  button("Send answer to agent").click();
  assert.deepEqual(sent[1], { type: "answerTeammate", questionId: "p1", text: "id, name, email" });
});

test("the team view shows live chats, what they are doing, and recent progress", () => {
  const { send, root, goTo } = mount();
  send({
    ...IN_TEAM,
    pulse: [
      { name: "Alice", me: true, chats: 2, focus: ["Login form"], updates: 0, latest: [] },
      { name: "Orlin", me: false, chats: 0, focus: [], updates: 3, latest: ["Finished the users API"] },
    ],
  });
  goTo("Team");
  assert.match(root.textContent, /Alice \(you\)/);
  assert.match(root.textContent, /2 chats active/);
  assert.match(root.textContent, /Login form/);
  assert.match(root.textContent, /3 updates in the last hour/);
  assert.match(root.textContent, /Finished the users API/);
  assert.equal(root.querySelectorAll(".av .pd.live").length, 1, "only Alice has a live dot");
});

// ---- Groups, group settings and profile ----

const type = (root: any, window: any, selector: string, value: string) => {
  const input = root.querySelector(selector);
  input.value = value;
  input.dispatchEvent(new window.Event("input"));
};
const texts = (root: any, selector: string) => [...root.querySelectorAll(selector)].map((node: any) => node.textContent);

test("the team name opens the groups page, with the size and role of each group", () => {
  const { send, root, button } = mount();
  send({ ...IN_TEAM, teams: [TEAM, { id: "t2", name: "Other", invite_code: "x", role: "member", members: 1 }] });
  button("Your groups").click();
  assert.ok(root.querySelector(".page-h h1").textContent === "Your groups");
  const cards = texts(root, ".gcard");
  assert.match(cards[0], /Team One/);
  assert.match(cards[0], /2 members · Lead · current/);
  assert.match(cards[1], /1 member · Member/);
  // Open switches group and goes back to the main view.
  button("Open").click();
  assert.equal(root.querySelector(".page"), null);
});

test("the groups page can also join or create another group", () => {
  const { send, root, sent, button } = mount();
  send(IN_TEAM);
  button("Your groups").click();
  const forms = [...root.querySelectorAll(".page form")] as any[];
  assert.equal(forms.length, 2);
  assert.equal(forms[0].querySelector('[name="displayName"]').value, "Alice", "the name is prefilled");
  forms[1].querySelector('[name="name"]').value = "Fresh";
  button("Create team").click();
  assert.deepEqual(sent.at(-1), { type: "createTeam", name: "Fresh", displayName: "Alice" });
});

test("a lead can rename, remove, promote, leave and delete from the settings page", () => {
  const { send, root, window, sent, button } = mount();
  send(IN_TEAM);
  button("Group settings").click();
  assert.equal(root.querySelector(".page-h h1").textContent, "Group settings");

  type(root, window, `#rename-${TEAM.id}`, "Better name");
  button("Save name").click();
  assert.deepEqual(sent.at(-1), { type: "renameTeam", name: "Better name" });

  assert.deepEqual(texts(root, ".mrow .hl"), ["Alice (you)", "Bob"]);
  button("Make lead").click();
  assert.deepEqual(sent.at(-1), { type: "setRole", userId: "u2", role: "lead" });

  // Removing, a new invite code and leaving need a second click.
  button("Remove").click();
  assert.ok(!sent.some((message) => message.type === "removeMember"));
  button("Sure?").click();
  assert.deepEqual(sent.at(-1), { type: "removeMember", userId: "u2" });

  button("Make a new code").click();
  assert.ok(!sent.some((message) => message.type === "regenerateInvite"));
  button("Replace it? The old code stops working").click();
  assert.deepEqual(sent.at(-1), { type: "regenerateInvite" });

  button("Leave group").click();
  assert.ok(!sent.some((message) => message.type === "leaveTeam"));
  button("Leave for good?").click();
  assert.deepEqual(sent.at(-1), { type: "leaveTeam" });
});

test("deleting a group needs its name typed", () => {
  const { send, root, window, sent, button } = mount();
  send(IN_TEAM);
  button("Group settings").click();
  assert.equal(button("Delete group").disabled, true);
  type(root, window, `#delete-${TEAM.id}`, "Team On");
  assert.equal(button("Delete group").disabled, true);
  type(root, window, `#delete-${TEAM.id}`, "Team One");
  assert.equal(button("Delete group").disabled, false);
  button("Delete group").click();
  assert.deepEqual(sent.at(-1), { type: "deleteTeam" });
});

test("a member sees the group but none of the lead's controls", () => {
  const { send, root, button } = mount();
  send(AS_MEMBER);
  button("Group settings").click();
  assert.match(root.querySelector(".page .hint").textContent, /Only a lead/);
  assert.equal(root.querySelector(`#rename-${TEAM.id}`), null);
  assert.equal(button("Save name"), undefined);
  assert.equal(button("Make a new code"), undefined);
  assert.equal(button("Remove"), undefined);
  assert.equal(button("Make lead"), undefined);
  assert.equal(button("Delete group"), undefined);
  assert.ok(button("Leave group"), "anyone can leave");
  assert.ok(root.querySelector(".inv-c"), "the invite code is still visible");
  assert.deepEqual(texts(root, ".role"), ["Member", "Lead"]);
});

test("the profile page changes the name and the password", () => {
  const { send, root, window, sent, button } = mount();
  send(IN_TEAM);
  button("Your profile").click();
  assert.equal(root.querySelector(".page-h h1").textContent, "Profile");
  assert.equal(root.querySelector("#profile-name").value, "Alice");
  type(root, window, "#profile-name", "Alice B");
  button("Save username").click();
  assert.deepEqual(sent.at(-1), { type: "updateProfile", displayName: "Alice B" });

  assert.equal(root.querySelector("#profile-password").type, "password");
  type(root, window, "#profile-password", "newsecret");
  type(root, window, "#profile-confirm", "newsecret");
  button("Change password").click();
  assert.deepEqual(sent.at(-1), { type: "changePassword", password: "newsecret", confirmPassword: "newsecret" });

  button("Back").click();
  assert.equal(root.querySelector(".page"), null);
});

test("the profile page works before the person is in any group", () => {
  const { send, root, button } = mount();
  send({ ...IN_TEAM, team: null, teams: [], members: [], user: { email: "a@example.com", displayName: null } });
  button("Your profile").click();
  assert.equal(root.querySelector("#profile-name").value, "", "the username can still be set");
  button("Back").click();
  assert.ok(root.querySelector(".team-choice"));
});

test("leaving the open group closes its settings page", () => {
  const { send, root, button } = mount();
  send(IN_TEAM);
  button("Group settings").click();
  assert.ok(root.querySelector(".page"));
  send({ ...IN_TEAM, team: null, teams: [], members: [], notice: "You left the group." });
  assert.equal(root.querySelector(".page"), null);
  assert.ok(root.querySelector(".team-choice"));
});

test("the profile button is the first letter in a balloon with the username", () => {
  const { send, root, button } = mount();
  send(IN_TEAM);
  const who = button("Your profile");
  assert.equal(who.querySelector(".av").textContent, "A");
  assert.equal(who.textContent, "AAlice");
  assert.equal(root.querySelector(".account .lnk")?.textContent, "Log out", "only Log out is a link");
  who.click();
  assert.equal(root.querySelector(".page-h h1").textContent, "Profile");
  send({ ...IN_TEAM, user: { email: "zed@example.com", displayName: null } });
  assert.equal(button("Your profile").textContent, "Zzed@example.com", "falls back to the email");
});

test("joining and creating a team look the same", () => {
  const { send, root } = mount();
  send({ ...IN_TEAM, team: null, teams: [] });
  const classes = [...root.querySelectorAll(".opt .btn")].map((node: any) => node.className);
  assert.equal(classes.length, 2);
  assert.equal(classes[0], classes[1]);
});

test("the group settings gear is the last button in the header row", () => {
  const { send, root } = mount();
  send(IN_TEAM);
  const labels = [...root.querySelectorAll(".acts .ib")].map((node: any) => node.getAttribute("aria-label"));
  assert.equal(labels.at(-1), "Group settings");
});

test("the groups button is just an icon next to the team name", () => {
  const { send, root, button } = mount();
  send(IN_TEAM);
  const groups = button("Your groups");
  assert.equal(groups.textContent, "", "no text");
  assert.ok(groups.querySelector("svg"));
  assert.ok(!groups.classList.contains("btn"), "no border or background of its own");
  assert.ok(!root.querySelector(".team").matches("button"));
});
