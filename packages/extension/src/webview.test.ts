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
  window.acquireVsCodeApi = () => ({ postMessage: (message: unknown) => sent.push(JSON.parse(JSON.stringify(message))) });
  window.eval(SCRIPT);
  const send = (state: unknown) =>
    window.dispatchEvent(new window.MessageEvent("message", { data: state }));
  const root = window.document.getElementById("root");
  const button = (text: string) =>
    [...root.querySelectorAll("button")].find((node: any) => node.textContent === text) as any;
  return { sent, send, window, root, button };
}

const SIGNED_OUT = { user: null, teams: [], team: null, workspace: "none", inbox: [], feed: [], notice: null, error: null };
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
  const { sent, send, root, button } = mount();
  send(SIGNED_OUT);
  button("Log in").click();
  assert.equal(sent.length, 1);
  root.querySelector('[name="email"]').value = "a@example.com";
  root.querySelector('[name="password"]').value = "secret";
  button("Log in").click();
  assert.deepEqual(sent[1], { type: "signIn", email: "a@example.com", password: "secret" });
  button("Create account").click();
  assert.deepEqual(sent[2], { type: "signUp", email: "a@example.com", password: "secret" });
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

test("the feed shows who did what", () => {
  const { send, root } = mount();
  send({ ...IN_TEAM, feed: [{ id: "e1", summary: "Fixed average", files: ["src/math.js"], created_at: "2026-11-02T10:00:00Z", author: "Bob" }] });
  assert.match(root.textContent, /Fixed average/);
  assert.match(root.textContent, /Bob/);
  assert.match(root.textContent, /src\/math\.js/);
});
