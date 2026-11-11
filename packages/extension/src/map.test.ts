// Runs the real map script in a simulated browser. Layout, zoom math, detail levels, fit and the
// link list are pure, so they are checked directly; drawing is checked through the DOM it makes.
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

// The script runs in jsdom's realm, so its arrays aren't this realm's; compare plain copies.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

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
const task = (id: string, extra: any = {}) => ({ id, title: `Task ${id}`, status: "todo", files: [], ...extra });
const OWNERS = [
  { id: "alice", name: "Alice", me: true },
  { id: "bob", name: "Bob", me: false },
];
// The v1 shape: none of the v2 fields.
const map = (chats: any[], threads: any[] = []) => ({ project: "Demo", owners: OWNERS, chats, threads });
const NOW = Date.parse("2026-11-04T12:00:00Z");
const FULL = (extra: any = {}) => ({
  project: "Demo",
  owners: [
    { id: "alice", name: "Alice", me: true, tasks: [task("t1", { status: "in_progress", title: "Checkout" }), task("t2")], doneTasks: 3 },
    { id: "bob", name: "Bob", me: false, tasks: [], doneTasks: 0 },
  ],
  chats: [chat("a1", "alice", { task: "Checkout" }), chat("b1", "bob", { state: "idle" })],
  threads: [],
  unassigned: [task("u1")],
  decisions: [{ id: "d1", text: "17% off", createdAt: "2026-11-03T10:00:00Z", question: "Discount?" }],
  stats: { tasks: { todo: 2, in_progress: 1, done: 3 }, openQuestions: 0, decisions: 1, activeChats: 1 },
  timeline: {
    from: "2026-11-03T08:00:00Z",
    items: [
      { id: "i1", at: "2026-11-03T10:00:00Z", kind: "decision", label: "17% off" },
      { id: "i2", at: "2026-11-03T20:00:00Z", kind: "task_done", label: "Checkout" },
    ],
  },
  ...extra,
});

test("v1 data without the new fields still draws", () => {
  const { root, send } = mount();
  send(map([chat("a1", "alice")]));
  assert.equal(root.querySelectorAll("circle.chat").length, 1);
  assert.equal(root.querySelectorAll("rect.task").length, 0);
});

test("layout puts every node in the world, and caps chats and tasks per person", () => {
  const { api } = mount();
  const chats = Array.from({ length: 9 }, (_, i) => chat(`c${i}`, "alice", { lastSeenAt: `2026-11-03T10:0${i}:00Z` }));
  const tasks = Array.from({ length: 7 }, (_, i) => task(`t${i}`, { status: i === 6 ? "in_progress" : "todo" }));
  const input = FULL({ owners: [{ id: "alice", name: "Alice", me: true, tasks, doneTasks: 0 }, FULL().owners[1]], chats: [...chats, chat("b1", "bob")] });
  const lay = plain(api.layout(input));
  assert.equal(Object.keys(lay.chats).filter((id) => id.startsWith("c")).length, api.MAX_CHATS);
  assert.equal(lay.hidden.alice, 4);
  assert.equal(Object.keys(lay.tasks).length, api.MAX_TASKS);
  assert.equal(lay.hiddenTasks.alice, 3);
  assert.ok(lay.tasks.t6, "an in-progress task is kept before to-do ones");
  const spots = [lay.project, ...Object.values<any>(lay.owners), ...Object.values<any>(lay.chats), ...Object.values<any>(lay.tasks), ...Object.values<any>(lay.unassigned), ...Object.values<any>(lay.decisions)];
  for (const spot of spots) assert.ok(spot.x > 0 && spot.x < lay.world.w && spot.y > 0 && spot.y < lay.world.h, JSON.stringify(spot));
});

test("a person's live chats are kept before ended ones when over the cap", () => {
  const { api } = mount();
  const chats = [
    ...Array.from({ length: 6 }, (_, i) => chat(`e${i}`, "alice", { state: "ended", lastSeenAt: `2026-11-03T11:0${i}:00Z` })),
    chat("live", "alice", { lastSeenAt: "2026-11-03T08:00:00Z" }),
  ];
  const { shown } = api.pickChats(chats, "alice");
  assert.equal(shown[0].id, "live");
  assert.equal(shown.length, api.MAX_CHATS);
});

test("links: project to person, chat to person, chat to task, handoff, and project to unassigned tasks and decisions", () => {
  const { api } = mount();
  const input = FULL({ chats: [chat("a1", "alice", { task: "Checkout" }), chat("a2", "alice", { state: "ended" }), chat("a3", "alice", { resumedFrom: "a2" }), chat("b1", "bob", { state: "idle" })] });
  const found = plain(api.links(input, api.layout(input)));
  const kinds = (kind: string) => found.filter((link: any) => link.kind === kind);
  assert.equal(kinds("project-person").length, 2);
  assert.equal(kinds("person-chat").length, 4);
  assert.equal(kinds("chat-task").length, 1, "Checkout is linked from the chat working on it");
  assert.equal(kinds("chat-task")[0].flow, "active");
  assert.equal(kinds("person-task").length, 1, "a task no chat names hangs off its person");
  assert.equal(kinds("handoff").length, 1);
  assert.equal(kinds("project-task").length, 1);
  assert.equal(kinds("project-decision").length, 1);
  assert.deepEqual(plain(found.filter((l: any) => l.kind === "person-chat").map((l: any) => l.flow)).sort(), ["active", "active", "ended", "idle"]);
  assert.equal(found.find((l: any) => l.id === "project:bob").flow, "idle");
});

test("thread links tether the asking chat to the card and on to the recipient", () => {
  const { api } = mount();
  const input = FULL({ threads: [thread("q1"), thread("q2", { toId: null, kind: "assumption" }), thread("q3", { status: "answered" })] });
  const lay = api.layout(input);
  const spots = { q1: { x: 10, y: 10 }, q2: { x: 300, y: 10 }, q3: { x: 600, y: 10 } };
  const found = plain(api.threadLinks(input, lay, spots));
  assert.equal(found.length, 4, "answered threads are not tethered");
  const route = found.find((l: any) => l.id === "q1:route");
  assert.deepEqual(route.to, plain(lay.owners.alice));
  assert.deepEqual(found.find((l: any) => l.id === "q2:route").to, plain(lay.project), "no recipient means the whole team");
  assert.equal(found.find((l: any) => l.id === "q1:ask").kind, "thread-question");
});

test("zoom keeps the point under the cursor still, and the scale stays inside its limits", () => {
  const { api } = mount();
  const view = { x: 40, y: -20, k: 1 };
  const zoomed = plain(api.zoomAt(view, 2, 300, 200));
  const before = { x: (300 - view.x) / view.k, y: (200 - view.y) / view.k };
  const after = { x: (300 - zoomed.x) / zoomed.k, y: (200 - zoomed.y) / zoomed.k };
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9);
  assert.equal(zoomed.k, 2);
  assert.equal(api.zoomAt(view, 1000, 0, 0).k, api.ZOOM.max);
  assert.equal(api.zoomAt(view, 0.0001, 0, 0).k, api.ZOOM.min);
});

test("fit centres the content in the stage and zooms out for big content", () => {
  const { api } = mount();
  const box = { minX: 100, minY: 100, maxX: 500, maxY: 300 };
  const fitted = plain(api.fitView(box, 800, 600));
  assert.ok(fitted.k > 0);
  const centre = { x: ((box.minX + box.maxX) / 2) * fitted.k + fitted.x, y: ((box.minY + box.maxY) / 2) * fitted.k + fitted.y };
  assert.ok(Math.abs(centre.x - 400) < 1e-9 && Math.abs(centre.y - 300) < 1e-9);
  assert.ok(api.fitView({ minX: 0, minY: 0, maxX: 8000, maxY: 6000 }, 800, 600).k < 0.3 + 1e-9, "never below the minimum scale");
  assert.equal(api.fitView({ minX: 0, minY: 0, maxX: 8000, maxY: 6000 }, 800, 600).k, api.ZOOM.min);
});

test("detail levels start at the named thresholds", () => {
  const { api } = mount();
  assert.equal(api.detailLevel(api.ZOOM.min), 0);
  assert.equal(api.detailLevel(api.LOD.medium), 1);
  assert.equal(api.detailLevel(api.LOD.close - 0.01), 1);
  assert.equal(api.detailLevel(api.LOD.close), 2);
  assert.equal(api.detailLevel(api.LOD.veryClose), 3);
  assert.equal(api.detailLevel(api.ZOOM.max), 3);
});

test("buttons, wheel, drag and double click change the view without rebuilding the scene", () => {
  const { root, send, window } = mount();
  send(FULL());
  const world = root.querySelector(".world");
  const dot = root.querySelector("circle.chat");
  const scale = () => Number(/scale\(([\d.]+)\)/.exec(world.style.transform)![1]);
  const fitted = scale();
  const button = (text: string) => [...root.querySelectorAll("button")].find((node: any) => node.textContent === text) as any;

  button("+").click();
  assert.ok(scale() > fitted);
  button("−").click();
  button("−").click();
  assert.ok(scale() < fitted);

  const wheel = new window.WheelEvent("wheel", { deltaY: -400, clientX: 100, clientY: 100, cancelable: true });
  root.querySelector(".stage").dispatchEvent(wheel);
  assert.equal(wheel.defaultPrevented, true);

  const before = world.style.transform;
  root.querySelector(".stage").dispatchEvent(new window.MouseEvent("mousedown", { button: 0, clientX: 10, clientY: 10, bubbles: true }));
  window.dispatchEvent(new window.MouseEvent("mousemove", { clientX: 60, clientY: 40 }));
  window.dispatchEvent(new window.MouseEvent("mouseup"));
  assert.notEqual(world.style.transform, before);

  button("Fit").click();
  assert.ok(Math.abs(scale() - fitted) < 1e-9);
  root.querySelector(".stage").dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
  assert.equal(root.querySelector("circle.chat"), dot, "zooming and fitting never rebuild the scene");
});

test("the zoom level sets one lod class on the world", () => {
  const { root, send } = mount();
  send(FULL());
  const world = root.querySelector(".world");
  const levels = () => [...world.classList].filter((name: string) => name.startsWith("lod-"));
  assert.equal(levels().length, 1);
  const plus = [...root.querySelectorAll("button")].find((node: any) => node.textContent === "+") as any;
  for (let i = 0; i < 12; i++) plus.click();
  assert.deepEqual([...levels()], ["lod-3"]);
});

test("the project shows a progress ring, task nodes, unassigned tasks and decisions", () => {
  const { root, send } = mount();
  send(FULL());
  const ring = root.querySelector("circle.ring-done");
  const radius = Number(ring.getAttribute("r"));
  const [done, total] = ring.getAttribute("stroke-dasharray").split(" ").map(Number);
  assert.ok(Math.abs(done / total - 3 / 6) < 1e-9, "3 of 6 tasks done");
  assert.ok(Math.abs(total - 2 * Math.PI * radius) < 1e-9);
  assert.equal(root.querySelectorAll("rect.task").length, 3);
  assert.equal(root.querySelectorAll("rect.task.unassigned").length, 1);
  assert.equal(root.querySelectorAll("circle.decision").length, 1);
  assert.ok([...root.querySelectorAll("text")].some((t: any) => t.textContent.includes("17% off")), "decision text exists for the closest zoom");
});

test("chats, tasks and links carry their state as classes, and a handoff flows between chats", () => {
  const { root, send } = mount();
  send(FULL({ chats: [chat("b1", "bob", { state: "ended" }), chat("b2", "bob", { resumedFrom: "b1" }), chat("a1", "alice", { state: "idle" })] }));
  assert.equal(root.querySelectorAll("circle.chat.ended").length, 1);
  assert.equal(root.querySelectorAll("circle.chat.idle").length, 1);
  assert.equal(root.querySelectorAll("circle.chat.active").length, 1);
  assert.equal(root.querySelectorAll("line.link.handoff").length, 1);
  assert.equal(root.querySelectorAll("line.link.person-chat.flow-ended").length, 1);
  assert.equal(root.querySelectorAll("rect.task.in_progress").length, 1);
});

test("close and very close detail: focus, state and last seen, task files", () => {
  const { root, send } = mount();
  send(FULL({ chats: [chat("a1", "alice", { focus: "Wiring checkout", lastSeenAt: new Date(Date.now() - 5 * 60_000).toISOString() })], owners: [{ id: "alice", name: "Alice", me: true, tasks: [task("t1", { files: ["a.ts", "b.ts"] })], doneTasks: 1 }, FULL().owners[1]] }));
  const texts = [...root.querySelectorAll("text")].map((t: any) => t.textContent);
  assert.ok(texts.includes("Wiring checkout"));
  assert.ok(texts.some((t: string) => /active · seen 5 min ago/.test(t)), texts.join("|"));
  assert.ok(texts.includes("a.ts, b.ts"));
  assert.ok(root.querySelector("text.label.lv2"));
  assert.ok(root.querySelector("text.label.lv3"));
});

test("agoText", () => {
  const { api } = mount();
  assert.equal(api.agoText("2026-11-04T11:59:40Z", NOW), "just now");
  assert.equal(api.agoText("2026-11-04T11:30:00Z", NOW), "30 min ago");
  assert.equal(api.agoText("2026-11-04T09:00:00Z", NOW), "3 h ago");
  assert.equal(api.agoText("2026-11-02T12:00:00Z", NOW), "2 d ago");
});

test("timeline markers are placed along the axis, in order, and labels appear only where there is room", () => {
  const { api } = mount();
  const items = [
    { id: "a", at: "2026-11-04T10:00:00Z", kind: "task_done", label: "A" },
    { id: "b", at: "2026-11-04T10:00:30Z", kind: "decision", label: "B" },
    { id: "c", at: "2026-11-04T11:00:00Z", kind: "question", label: "C" },
    { id: "d", at: "2026-11-03T08:00:00Z", kind: "question", label: "D" },
  ];
  const markers = plain(api.timelineLayout({ from: "2026-11-03T08:00:00Z", items }, NOW, 1000));
  assert.deepEqual(markers.map((m: any) => m.id), ["d", "a", "b", "c"]);
  assert.equal(markers[0].pct, 0);
  assert.ok(markers.every((m: any, i: number) => i === 0 || m.pct >= markers[i - 1].pct));
  assert.ok(markers[3].pct <= 100);
  const shown = markers.filter((m: any) => m.showLabel).map((m: any) => m.id);
  assert.ok(shown.includes("d") || shown.includes("a"));
  assert.ok(!(shown.includes("a") && shown.includes("b")), "a and b are too close for two labels");
});

test("the timeline strip shows done of total, markers with titles, and no strip data when it is missing", () => {
  const { root, send } = mount();
  send(FULL());
  assert.match(root.querySelector(".progress").textContent, /3 of 6 tasks done/);
  assert.equal(root.querySelector(".bar-fill").style.width, "50%");
  const markers = [...root.querySelectorAll(".marker")];
  assert.equal(markers.length, 2);
  assert.ok(markers.every((m: any) => m.getAttribute("title")));
  send({ ...FULL(), timeline: null });
  assert.equal(root.querySelectorAll(".marker").length, 0);
  assert.ok(root.querySelector(".progress"));
});

test("diff finds new and answered threads, progress, endings and takeovers; the first state animates nothing", () => {
  const { api } = mount();
  const before = map([chat("b1", "bob"), chat("a1", "alice")], [thread("q1")]);
  assert.deepEqual(Object.values(plain(api.diff(null, before))).flat(), []);
  const after = map(
    [chat("b1", "bob", { state: "ended" }), chat("a1", "alice", { lastProgressAt: "2026-11-03T10:05:00Z" }), chat("b2", "bob", { resumedFrom: "b1" })],
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

test("placeCards keeps cards in the world and apart from each other", () => {
  const { api } = mount();
  const world = { w: 900, h: 560 };
  const spots = plain(api.placeCards([{ id: "a", x: 850, y: 100 }, { id: "b", x: 850, y: 100 }, { id: "c", x: 850, y: 100 }], world));
  for (const spot of spots) assert.ok(spot.x >= 0 && spot.x + 240 <= 900 && spot.y >= 0 && spot.y + 130 <= 560, JSON.stringify(spot));
  for (let i = 0; i < spots.length; i++)
    for (let j = i + 1; j < spots.length; j++) {
      const a = spots[i];
      const b = spots[j];
      assert.ok(a.x + 240 <= b.x || b.x + 240 <= a.x || a.y + 130 <= b.y || b.y + 130 <= a.y, `${a.id} overlaps ${b.id}`);
    }
});

test("asks the extension for state on load, and shows a hint until there is a map", () => {
  const { sent, root, send, window } = mount();
  assert.deepEqual(sent, [{ type: "ready" }]);
  assert.match(root.querySelector(".empty").textContent, /join a team/);
  send(map([chat("a1", "alice")]));
  assert.equal(root.querySelector(".empty").hidden, true);
  assert.match(root.querySelector("h1").textContent, /Demo/);
  window.dispatchEvent(new window.MessageEvent("message", { data: { user: null } }));
  assert.equal(root.querySelector(".empty").hidden, false);
  assert.equal(root.querySelectorAll("circle.chat").length, 0);
});

test("there is no demo any more", () => {
  const { root, api } = mount();
  assert.equal([...root.querySelectorAll("button")].some((node: any) => /demo/i.test(node.textContent)), false);
  assert.equal(api.demoFrames, undefined);
  assert.doesNotMatch(SCRIPT, /demo/i);
});

test("untrusted text is rendered as text, never as HTML", () => {
  const { root, send } = mount();
  const evil = '<img src=x onerror="alert(1)">';
  send(FULL({
    chats: [chat("b1", "bob", { task: evil, focus: evil })],
    threads: [thread("q1", { text: evil, context: evil })],
    decisions: [{ id: "d1", text: evil, createdAt: "2026-11-03T10:00:00Z", question: null }],
    unassigned: [task("u1", { title: evil })],
  }));
  assert.equal(root.querySelectorAll("img").length, 0);
  assert.ok(root.querySelector(".card-text").textContent.includes("<img"));
});

test("a new thread opens a tethered card; mine threads have an answer box that posts the right message", () => {
  const { sent, root, send } = mount();
  send(map([chat("b1", "bob")]));
  assert.equal(root.querySelectorAll(".card").length, 0);

  send(map([chat("b1", "bob")], [thread("q1", { mine: true }), thread("p1", { kind: "agent", mine: true }), thread("s1", { kind: "assumption", mine: true })]));
  const cards = [...root.querySelectorAll(".card")];
  assert.equal(cards.length, 3);
  assert.ok(root.querySelector(".card.question.entering"));
  assert.equal(root.querySelectorAll("line.link.thread-question").length, 2, "chat to card and card to recipient");
  assert.equal(root.querySelectorAll("line.link.thread-agent").length, 2);
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
  (withInput[0] as any).querySelector("button").click();
  assert.equal(sent.length, 3, "empty text sends nothing");
});

test("cards zoom with the scene: they live in the world and carry a detail level", () => {
  const { root, send } = mount();
  send(map([chat("b1", "bob")], [thread("q1", { mine: true })]));
  const card = root.querySelector(".card");
  assert.ok(root.querySelector(".world").contains(card));
  assert.ok(card.classList.contains("lv1"));
  assert.ok(card.querySelector(".card-text").classList.contains("lv2"));
  assert.ok(card.querySelector(".card-context").classList.contains("lv3"));
  assert.ok(card.style.left.endsWith("px"));
});

test("a typed answer survives a state refresh that doesn't change the card", () => {
  const { root, send } = mount();
  send(map([chat("b1", "bob")]));
  send(map([chat("b1", "bob")], [thread("q1", { mine: true })]));
  root.querySelector(".card input").value = "half typed";
  send(map([chat("b1", "bob", { lastProgressAt: "2026-11-03T10:09:00Z" })], [thread("q1", { mine: true })]));
  assert.equal(root.querySelector(".card input").value, "half typed");
});

test("an answered thread shows its answer, loses its tether, and the card collapses later", () => {
  const { root, send } = mount();
  send(map([chat("b1", "bob")]));
  send(map([chat("b1", "bob")], [thread("q1")]));
  assert.equal(root.querySelectorAll("line.link.thread-question").length, 2);
  send(map([chat("b1", "bob")], [thread("q1", { status: "answered", answer: "Blue" })]));
  assert.match(root.querySelector(".card.answered").textContent, /Answer: Blue/);
  assert.equal(root.querySelectorAll("line.link.thread-question").length, 0);
});

test("progress sends a pulse, then lines from chat to person to project", () => {
  const { root, send } = mount();
  send(map([chat("b1", "bob"), chat("a1", "alice")]));
  send(map([chat("b1", "bob", { lastProgressAt: "2026-11-03T10:09:00Z" }), chat("a1", "alice")], [thread("q1")]));
  assert.equal(root.querySelectorAll("circle.fx-pulse.progress").length, 1);
  assert.equal(root.querySelectorAll("line.fx-line.progress").length, 2);
  assert.equal(root.querySelectorAll("line.fx-line.question").length, 1);
});

test("a thread to the whole team sends its line to the project", () => {
  const { root, send } = mount();
  send(map([chat("b1", "bob")]));
  send(map([chat("b1", "bob")], [thread("s1", { kind: "assumption", toId: null })]));
  const project = root.querySelector("circle.project");
  assert.equal(root.querySelector("line.fx-line.assumption").getAttribute("x2"), project.getAttribute("cx"));
});

test("the script uses no innerHTML and no style attributes", () => {
  assert.doesNotMatch(SCRIPT, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.doesNotMatch(SCRIPT, /setAttribute\(\s*["']style["']/);
  assert.doesNotMatch(SCRIPT, /["']style["']\s*:/);
});

test("the stylesheet respects reduced motion", () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../media/map.css"), "utf8");
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*animation: none/);
});

test("the area filter shows only the tasks of one area, keeps the counts, and is hidden without areas", () => {
  const { root, send } = mount();
  send(FULL());
  assert.equal(root.querySelector('[aria-label="Filter tasks by area"]').hidden, true);
  const labelled = FULL({
    owners: [
      { id: "alice", name: "Alice", me: true, tasks: [task("t1", { area: "code" }), task("t2", { area: "art" }), task("t3")], doneTasks: 3 },
      FULL().owners[1],
    ],
    unassigned: [task("u1", { area: "art" }), task("u2", { area: "audio" })],
  });
  send(labelled);
  const bar = root.querySelector('[aria-label="Filter tasks by area"]');
  assert.equal(bar.hidden, false);
  assert.equal(root.querySelectorAll("rect.task").length, 5);

  const press = (text: string) => [...bar.querySelectorAll("button")].find((node: any) => node.textContent === text).click();
  press("art");
  assert.equal(root.querySelectorAll("rect.task").length, 2, "one owned and one unassigned art task");
  assert.equal(root.querySelectorAll("rect.task.unassigned").length, 1);
  assert.match(root.querySelector(".progress").textContent, /3 of 6 tasks done/, "counts stay whole");
  assert.equal([...bar.querySelectorAll("button")].find((node: any) => node.textContent === "art").getAttribute("aria-pressed"), "true");

  press("All areas");
  assert.equal(root.querySelectorAll("rect.task").length, 5);
});

test("filterByArea is pure and leaves other areas out", () => {
  const { api } = mount();
  const input = FULL({ owners: [{ id: "alice", name: "Alice", me: true, tasks: [task("t1", { area: "code" }), task("t2", { area: "art" })], doneTasks: 0 }], unassigned: [task("u1", { area: "code" })] });
  const filtered = plain(api.filterByArea(input, "code"));
  assert.deepEqual(filtered.owners[0].tasks.map((t: any) => t.id), ["t1"]);
  assert.deepEqual(filtered.unassigned.map((t: any) => t.id), ["u1"]);
  assert.equal(api.filterByArea(input, ""), input);
  assert.equal(input.owners[0].tasks.length, 2, "the input is not changed");
});
