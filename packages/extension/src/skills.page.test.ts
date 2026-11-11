// Runs the real Hacky Skills script in a simulated browser.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const SCRIPT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../media/skills.js"), "utf8");

function mount() {
  const sent: any[] = [];
  const dom = new JSDOM('<!DOCTYPE html><div id="root"></div>', { runScripts: "outside-only" });
  const window = dom.window as any;
  window.acquireVsCodeApi = () => ({ postMessage: (message: unknown) => sent.push(JSON.parse(JSON.stringify(message))) });
  window.eval(SCRIPT);
  const root = window.document.getElementById("root");
  const send = (state: unknown) => window.dispatchEvent(new window.MessageEvent("message", { data: state }));
  const click = (text: string) => ([...root.querySelectorAll("button")].find((node: any) => node.textContent === text || node.getAttribute("aria-label") === text) as any).click();
  return { sent, send, root, window, click };
}

const PREVIEW = {
  repo: "o/r",
  path: "skills/caveman",
  sha: "a".repeat(40),
  name: "caveman",
  text: "<img src=x onerror=alert(1)> Talk short.",
  truncated: false,
  files: [{ path: "SKILL.md", size: 100 }, { path: "run.sh", size: 2048 }],
  risky: ["run.sh"],
};
const BASE = {
  user: { email: "a@example.com", displayName: "Alice" },
  team: { id: "t", name: "Team" },
  workspace: "connected",
  folder: null,
  error: null,
  notice: null,
  skills: { team: [], lookup: null, fromTeam: false },
};

test("asks to log in first", () => {
  const { send, root } = mount();
  send({ ...BASE, user: null });
  assert.match(root.textContent, /Log in and choose a team/);
});

test("looking a link up sends it", () => {
  const { send, root, sent, window } = mount();
  send(BASE);
  const input = root.querySelector("#skill-url");
  input.value = " github.com/o/r ";
  input.dispatchEvent(new window.Event("input"));
  root.querySelector("form").dispatchEvent(new window.Event("submit", { cancelable: true }));
  assert.deepEqual(sent.at(-1), { type: "previewSkill", url: "github.com/o/r" });
});

test("a preview shows the text as text, the warnings, and installs with the share choice", () => {
  const { send, root, sent, click } = mount();
  send({ ...BASE, skills: { team: [], lookup: { kind: "preview", preview: PREVIEW }, fromTeam: false } });
  assert.equal(root.querySelector("img"), null, "the skill's text is never turned into HTML");
  assert.match(root.querySelector(".skill-text").textContent, /<img src=x/);
  assert.match(root.textContent, /never runs them/);
  assert.match(root.textContent, /Not plain text.*run\.sh/);
  assert.match(root.textContent, /aaaaaaa/);
  click("Install");
  assert.deepEqual(sent.at(-1), { type: "installSkill", share: true });
  root.querySelector("#skill-share").checked = false;
  click("Install");
  assert.deepEqual(sent.at(-1), { type: "installSkill", share: false });
  click("Cancel");
  assert.deepEqual(sent.at(-1), { type: "cancelSkill" });
});

test("install is disabled until a folder is chosen, and a teammate's skill has no share box", () => {
  const { send, root } = mount();
  send({ ...BASE, workspace: "none", skills: { team: [], lookup: { kind: "preview", preview: PREVIEW }, fromTeam: true } });
  assert.ok([...root.querySelectorAll("button")].find((node: any) => node.textContent === "Install").hasAttribute("disabled"));
  assert.equal(root.querySelector("#skill-share"), null);
  assert.match(root.textContent, /Choose a project folder first/);
});

test("several skills found: pick one to read", () => {
  const { send, sent, click } = mount();
  send({ ...BASE, skills: { team: [], lookup: { kind: "choose", repo: "o/r", sha: "a".repeat(40), candidates: [{ name: "a", path: "x/a" }, { name: "b", path: "x/b" }] }, fromTeam: false } });
  click("Read");
  assert.deepEqual(sent.at(-1), { type: "pickSkill", path: "x/a" });
});

test("the team list offers the right button for how each skill stands here", () => {
  const { send, root, sent, click } = mount();
  const skill = (id: string, name: string, local: string) => ({ id, name, repo: "o/r", path: name, sha: "a".repeat(40), addedBy: "Bob", local });
  send({ ...BASE, skills: { team: [skill("1", "fresh", "none"), skill("2", "old", "outdated"), skill("3", "same", "current"), skill("4", "mine", "manual")], lookup: null, fromTeam: false } });
  const labels = (card: number) => [...root.querySelectorAll(".skill")[card].querySelectorAll("button")].map((b: any) => b.textContent);
  assert.deepEqual(labels(0), ["Install", "Unshare"]);
  assert.deepEqual(labels(1), ["Update", "Remove here", "Unshare"]);
  assert.deepEqual(labels(2), ["Remove here", "Unshare"]);
  assert.deepEqual(labels(3), ["Unshare"]);
  assert.match(root.textContent, /added by Bob/);
  click("Unshare fresh");
  assert.deepEqual(sent.at(-1), { type: "unshareSkill", skillId: "1" });
  click("Remove old from this folder");
  assert.deepEqual(sent.at(-1), { type: "removeLocalSkill", name: "old" });
});

test("shows errors and notices", () => {
  const { send, root } = mount();
  send({ ...BASE, error: "No SKILL.md found there.", notice: null });
  assert.match(root.querySelector('[role="alert"]').textContent, /No SKILL\.md/);
});
