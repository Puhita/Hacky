// Runs the real map script in a simulated browser. Layout and diffing are pure, so they are
// checked directly; drawing is checked through the DOM it produces.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const SCRIPT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../media/map.js"), "utf8");

function mount() {
  const sent: any[] = [];
  const dom = new JSDOM('<!DOCTYPE html><div id="root"></div>', { runScripts: "outside-only" });
  const window = dom.window as any;
  window.acquireVsCodeApi = () => ({ postMessage: (message: unknown) => sent.push(JSON.parse(JSON.stringify(message))) });
  window.eval(SCRIPT);
  const send = (map: unknown) => window.dispatchEvent(new window.MessageEvent("message", { data: { map } }));
  const root = window.document.getElementById("root");
  return { sent, send, window, root, api: window.HackyMap };
}

const chat = (id: string, ownerId: string, extra: any = {}) => ({
  id,
  ownerId,
  state: "active",
  focus: "Working",
  task: null,
  lastProgressAt: null,
  lastSeenAt: "2026-11-03T10:00:00Z",
  startedAt: "2026-11-03T09:00:00Z",
  resumedFrom: null,
  ...extra,
});
const thread = (id: string, extra: any = {}) => ({
  id,
  kind: "question",
  askerId: "bob",
  chatId: "b1",
  toId: "alice",
  text: "Which colour?",
  context: "Theme",
  status: "open",
  answer: null,
  waiting: 1,
  createdAt: "2026-11-03T10:00:00Z",
  mine: false,
  ...extra,
});
// The script runs in jsdom's realm, so its arrays aren't this realm's; compare plain copies.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const OWNERS = [
  { id: "alice", name: "Alice", me: true },
  { id: "bob", name: "Bob", me: false },
];
const map = (chats: any[], threads: any[] = []) => ({ project: "Demo", owners: OWNERS, chats, threads });

test("layout puts every person and shown chat inside the stage, and caps chats per person", () => {
  const { api } = mount();
  const chats = Array.from({ length: 9 }, (_, i) => chat(`c${i}`, "alice", { lastSeenAt: `2026-11-03T10:0${i}:00Z` }));
  const result = api.layout(map([...chats, chat("b1", "bob")]), 900, 560);
  assert.equal(Object.keys(result.owners).length, 2);
  assert.equal(Object.keys(result.chats).filter((id) => id.startsWith("c")).length, api.MAX_CHATS_PER_OWNER);
  assert.equal(result.hidden.alice, 4);
  for (const spot of [...Object.values<any>(result.owners), ...Object.values<any>(result.chats)]) {
    assert.ok(spot.x > 0 && spot.x < 900 && spot.y > 0 && spot.y < 560, JSON.stringify(spot));
  }
});

test("a person's live chats are kept before ended ones when over the cap", () => {
  const { api } = mount();
  const chats = [
    ...Array.from({ length: 6 }, (_, i) => chat(`e${i}`, "alice", { state: "ended", lastSeenAt: `2026-11-03T11:0${i}:00Z` })),
    chat("live", "alice", { lastSeenAt: "2026-11-03T08:00:00Z" }),
  ];
  const { shown } = api.pickChats(chats, "alice");
  assert.equal(shown[0].id, "live");
  assert.equal(shown.length, api.MAX_CHATS_PER_OWNER);
});

test("diff finds new and answered threads, progress, endings and takeovers; the first state animates nothing", () => {
  const { api } = mount();
  const before = map([chat("b1", "bob"), chat("a1", "alice")], [thread("q1")]);
  const empty = plain(api.diff(null, before));
  assert.deepEqual(Object.values(empty).flat(), []);

  const after = map(
    [
      chat("b1", "bob", { state: "ended" }),
      chat("a1", "alice", { lastProgressAt: "2026-11-03T10:05:00Z" }),
      chat("b2", "bob", { resumedFrom: "b1" }),
    ],
    [thread("q1", { status: "answered", answer: "Blue" }), thread("q2", { text: "Which font?" })],
  );
  const changes = plain(api.diff(before, after));
  assert.deepEqual(changes.newThreads.map((t: any) => t.id), ["q2"]);
  assert.deepEqual(changes.answered.map((t: any) => t.id), ["q1"]);
  assert.deepEqual(changes.progressed, ["a1"]);
  assert.deepEqual(changes.newlyEnded, ["b1"]);
  assert.deepEqual(changes.takeovers, [{ from: "b1", to: "b2" }]);
  assert.deepEqual(plain(api.diff(before, map([chat("b1", "bob")], []))).removed, ["q1"]);
});

test("placeCards keeps cards on the stage and apart from each other", () => {
  const { api } = mount();
  const spots = api.placeCards(
    [
      { id: "a", x: 850, y: 100 },
      { id: "b", x: 850, y: 100 },
      { id: "c", x: 850, y: 100 },
    ],
    900,
    560,
  );
  for (const spot of spots) assert.ok(spot.x >= 0 && spot.x + 240 <= 900 && spot.y >= 0 && spot.y + 130 <= 560, JSON.stringify(spot));
  for (let i = 0; i < spots.length; i++)
    for (let j = i + 1; j < spots.length; j++) {
      const a = spots[i];
      const b = spots[j];
      const apart = a.x + 240 <= b.x || b.x + 240 <= a.x || a.y + 130 <= b.y || b.y + 130 <= a.y;
      assert.ok(apart, `${a.id} overlaps ${b.id}`);
    }
});

test("asks the extension for state on load, and shows a hint until there is a map", () => {
  const { sent, root, send } = mount();
  assert.deepEqual(sent, [{ type: "ready" }]);
  assert.match(root.querySelector(".empty").textContent, /join a team/);
  send(map([chat("a1", "alice")]));
  assert.equal(root.querySelector(".empty").hidden, true);
  assert.match(root.querySelector("h1").textContent, /Demo/);
  assert.equal(root.querySelectorAll("circle.chat").length, 1);
});

test("untrusted text is rendered as text, never as HTML", () => {
  const { root, send } = mount();
  const evil = '<img src=x onerror="alert(1)">';
  send(map([chat("b1", "bob", { task: evil })], [thread("q1", { text: evil, context: evil })]));
  assert.equal(root.querySelectorAll("img").length, 0);
  assert.ok(root.querySelector(".card-text").textContent.includes("<img"));
});

test("a new thread opens a card, a mine thread has an answer box that posts the right message", () => {
  const { sent, root, send, window } = mount();
  send(map([chat("b1", "bob")]));
  assert.equal(root.querySelectorAll(".card").length, 0);

  send(map([chat("b1", "bob")], [thread("q1", { mine: true }), thread("p1", { kind: "agent", mine: true }), thread("s1", { kind: "assumption", mine: true })]));
  const cards = [...root.querySelectorAll(".card")];
  assert.equal(cards.length, 3);
  assert.ok(root.querySelector(".card.question.entering"));
  const withInput = cards.filter((card: any) => card.querySelector("input"));
  assert.equal(withInput.length, 2, "assumptions have no answer box");

  for (const card of withInput as any[]) {
    card.querySelector("input").value = "Blue";
    card.querySelector("button").click();
  }
  assert.deepEqual(sent.slice(1), [
    { type: "answer", questionId: "q1", text: "Blue" },
    { type: "answerTeammate", questionId: "p1", text: "Blue" },
  ]);
  // Empty text sends nothing.
  (withInput[0] as any).querySelector("button").click();
  assert.equal(sent.length, 3);
  assert.ok(window);
});

test("a typed answer survives a state refresh that doesn't change the card", () => {
  const { root, send } = mount();
  send(map([chat("b1", "bob")]));
  send(map([chat("b1", "bob")], [thread("q1", { mine: true })]));
  root.querySelector(".card input").value = "half typed";
  send(map([chat("b1", "bob", { lastProgressAt: "2026-11-03T10:09:00Z" })], [thread("q1", { mine: true })]));
  assert.equal(root.querySelector(".card input").value, "half typed");
});

test("an answered thread shows its answer, then collapses", async () => {
  const { root, send } = mount();
  send(map([chat("b1", "bob")]));
  send(map([chat("b1", "bob")], [thread("q1")]));
  send(map([chat("b1", "bob")], [thread("q1", { status: "answered", answer: "Blue" })]));
  const card = root.querySelector(".card.answered");
  assert.match(card.textContent, /Answer: Blue/);
  assert.equal(root.querySelectorAll(".card").length, 1);
});

test("chat states and a taken-over chat are drawn", () => {
  const { root, send } = mount();
  send(map([chat("b1", "bob", { state: "ended" }), chat("b2", "bob", { resumedFrom: "b1" }), chat("a1", "alice", { state: "idle" })]));
  assert.equal(root.querySelectorAll("circle.chat.ended").length, 1);
  assert.equal(root.querySelectorAll("circle.chat.idle").length, 1);
  assert.equal(root.querySelectorAll("circle.chat.active").length, 1);
  assert.equal(root.querySelectorAll("line.flow").length, 1);
});

test("progress and a new thread create transient effects", () => {
  const { root, send } = mount();
  send(map([chat("b1", "bob"), chat("a1", "alice")]));
  send(map([chat("b1", "bob", { lastProgressAt: "2026-11-03T10:09:00Z" }), chat("a1", "alice")], [thread("q1")]));
  assert.equal(root.querySelectorAll("circle.fx-pulse.progress").length, 1);
  assert.equal(root.querySelectorAll("line.fx-line.question").length, 1);
});

test("a thread to the whole team sends its line to the project", () => {
  const { root, send } = mount();
  send(map([chat("b1", "bob")]));
  send(map([chat("b1", "bob")], [thread("s1", { kind: "assumption", toId: null })]));
  const project = root.querySelector("circle.project");
  const line = root.querySelector("line.fx-line.assumption");
  assert.equal(line.getAttribute("x2"), project.getAttribute("cx"));
});

test("demo plays on its own and stops cleanly; answering in the demo posts nothing", async () => {
  const { sent, root, window } = mount();
  const button = [...root.querySelectorAll("button")].find((node: any) => node.textContent === "Demo") as any;
  button.click();
  assert.equal(button.textContent, "Stop demo");
  await new Promise((resolve) => setTimeout(resolve, 3300));
  assert.ok(root.querySelectorAll("circle.chat").length >= 3);
  assert.ok(root.querySelector(".card input"), "demo question addressed to the viewer");
  root.querySelector(".card input").value = "17%";
  root.querySelector(".card button").click();
  assert.match(root.querySelector(".card.answered").textContent, /17%/);
  assert.deepEqual(sent, [{ type: "ready" }]);
  button.click();
  assert.equal(button.textContent, "Demo");
  assert.equal(root.querySelectorAll(".card").length, 0);
  window.close();
});

test("the script uses no innerHTML and no style attributes", () => {
  assert.doesNotMatch(SCRIPT, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.doesNotMatch(SCRIPT, /setAttribute\(\s*["']style["']/);
});
