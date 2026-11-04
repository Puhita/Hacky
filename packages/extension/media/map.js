// Hacky Map: the project in the middle, people around it, their chats and tasks next to them,
// open questions as cards tethered to who asked and who must answer, and a timeline strip at the
// bottom. The scene lives in one world that is zoomed and panned with a CSS transform; the level
// of detail follows the zoom through classes, so zooming never rebuilds anything. Names, titles,
// questions and answers come from teammates and agents, so they are untrusted: everything is
// rendered through textContent, never as HTML. The CSP forbids style attributes and blocks, so
// styling is classes in map.css plus element.style assignments from here.
(function () {
  // ---- Tuning: sizes, distances and limits (colours and speeds are variables in map.css) ----
  const SIZE = { project: 44, person: 20, chat: 9, task: 7, small: 6, ring: 6 };
  const DIST = { orbit: 95, task: 175, column: 84, rowGap: 22, ringMin: 380, ringPerOwner: 120, margin: 260 };
  const MAX_CHATS = 5; // per person
  const MAX_TASKS = 4; // per person
  const ZOOM = { min: 0.3, max: 4, step: 1.25, wheel: 0.0015, fitPad: 48 };
  // Scale at which each level of detail starts: 0 far, 1 medium, 2 close, 3 very close.
  const LOD = { medium: 0.6, close: 1.2, veryClose: 2.2 };
  const CARD = { w: 240, h: 130, gap: 8 };
  const TIMELINE = { labelGap: 150, labelMax: 26 };
  const SVG_NS = "http://www.w3.org/2000/svg";

  // ---- Pure functions (also exposed on window.HackyMap for tests) ----

  const STATE_RANK = { active: 0, idle: 1, ended: 2 };
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const clip = (text, max) => (text && text.length > max ? text.slice(0, max - 1) + "…" : text || "");

  // The map from the extension, with every field that may be missing filled in.
  function normalize(map) {
    const owners = map.owners.map((owner) => ({ ...owner, tasks: owner.tasks || [], doneTasks: owner.doneTasks || 0 }));
    const threads = map.threads || [];
    const taskCount = (status) => owners.reduce((sum, owner) => sum + owner.tasks.filter((t) => t.status === status).length, 0);
    const stats = map.stats || {
      tasks: { todo: taskCount("todo"), in_progress: taskCount("in_progress"), done: owners.reduce((sum, o) => sum + o.doneTasks, 0) },
      openQuestions: threads.filter((thread) => thread.status === "open").length,
      decisions: (map.decisions || []).length,
      activeChats: map.chats.filter((chat) => chat.state === "active").length,
    };
    return { ...map, owners, threads, unassigned: map.unassigned || [], decisions: map.decisions || [], stats, timeline: map.timeline || null };
  }

  // The chats of one person worth drawing: live ones first, then newest, capped.
  function pickChats(chats, ownerId) {
    const mine = chats.filter((chat) => chat.ownerId === ownerId);
    mine.sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
    return { shown: mine.slice(0, MAX_CHATS), hidden: Math.max(0, mine.length - MAX_CHATS) };
  }

  // A person's open tasks worth drawing: in progress first, capped.
  function pickTasks(tasks) {
    const open = tasks.filter((task) => task.status !== "done");
    const sorted = [...open.filter((t) => t.status === "in_progress"), ...open.filter((t) => t.status !== "in_progress")];
    return { shown: sorted.slice(0, MAX_TASKS), hidden: Math.max(0, sorted.length - MAX_TASKS) };
  }

  // World positions for everything. The world is as big as the content needs.
  function layout(input) {
    const map = normalize(input);
    const count = map.owners.length;
    const ringR = Math.max(DIST.ringMin, count * DIST.ringPerOwner);
    const half = ringR + DIST.task + DIST.margin;
    const world = { w: half * 2, h: half * 2 };
    const project = { x: half, y: half };
    const lay = { world, project, owners: {}, chats: {}, tasks: {}, unassigned: {}, decisions: {}, hidden: {}, hiddenTasks: {} };
    map.owners.forEach((owner, index) => {
      const angle = -Math.PI / 2 + (2 * Math.PI * index) / Math.max(1, count);
      const at = (radius, a) => ({ x: lay.owners[owner.id].x + radius * Math.cos(a), y: lay.owners[owner.id].y + radius * Math.sin(a) });
      lay.owners[owner.id] = {
        x: count === 1 ? half : half + ringR * Math.cos(angle),
        y: count === 1 ? half - ringR : half + ringR * Math.sin(angle),
        angle,
      };
      const chats = pickChats(map.chats, owner.id);
      lay.hidden[owner.id] = chats.hidden;
      const chatStep = Math.min(0.9, (2 * Math.PI) / Math.max(1, chats.shown.length));
      chats.shown.forEach((chat, k) => {
        lay.chats[chat.id] = at(DIST.orbit, angle + (k - (chats.shown.length - 1) / 2) * chatStep);
      });
      const tasks = pickTasks(owner.tasks);
      lay.hiddenTasks[owner.id] = tasks.hidden;
      tasks.shown.forEach((task, k) => {
        lay.tasks[task.id] = { ...at(DIST.task, angle + (k - (tasks.shown.length - 1) / 2) * 0.5), ownerId: owner.id };
      });
    });
    // Unassigned tasks in a column left of the project, decisions in one on the right.
    const column = (items, side, into) =>
      items.forEach((item, i) => {
        into[item.id] = { x: project.x + side * DIST.column, y: project.y + (i - (items.length - 1) / 2) * DIST.rowGap };
      });
    column(map.unassigned, -1, lay.unassigned);
    column(map.decisions, 1, lay.decisions);
    return lay;
  }

  // Every connection in the scene. `from` to `to` is the direction things flow; `flow` is how
  // busy it is (active, idle or ended) and sets its speed and brightness.
  function links(input, lay) {
    const map = normalize(input);
    const out = [];
    const add = (id, kind, from, to, flow) => from && to && out.push({ id, kind, from, to, flow });
    for (const owner of map.owners) {
      const mine = map.chats.filter((chat) => chat.ownerId === owner.id);
      const flow = mine.some((chat) => chat.state === "active") ? "active" : mine.some((chat) => chat.state === "idle") ? "idle" : "ended";
      add(`project:${owner.id}`, "project-person", lay.owners[owner.id], lay.project, flow);
    }
    for (const chat of map.chats) {
      add(`chat:${chat.id}`, "person-chat", lay.chats[chat.id], lay.owners[chat.ownerId], chat.state);
    }
    for (const owner of map.owners) {
      for (const task of owner.tasks) {
        const spot = lay.tasks[task.id];
        if (!spot) continue;
        const chat = map.chats.filter((c) => c.ownerId === owner.id && c.task === task.title && lay.chats[c.id]).sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state])[0];
        const flow = chat && chat.state === "active" && task.status === "in_progress" ? "active" : "idle";
        if (chat) add(`task:${task.id}`, "chat-task", lay.chats[chat.id], spot, flow);
        else add(`task:${task.id}`, "person-task", lay.owners[owner.id], spot, flow);
      }
    }
    for (const chat of map.chats) add(`handoff:${chat.id}`, "handoff", chat.resumedFrom && lay.chats[chat.resumedFrom], lay.chats[chat.id], "active");
    for (const task of map.unassigned) add(`un:${task.id}`, "project-task", lay.project, lay.unassigned[task.id], "idle");
    for (const decision of map.decisions) add(`dec:${decision.id}`, "project-decision", lay.project, lay.decisions[decision.id], "idle");
    return out;
  }

  // Open threads stay tethered from the asking chat to the card and on to whoever must answer,
  // flowing toward the recipient.
  function threadLinks(input, lay, cardSpots) {
    const map = normalize(input);
    const out = [];
    for (const thread of map.threads) {
      const spot = cardSpots[thread.id];
      if (thread.status !== "open" || !spot) continue;
      const card = { x: spot.x + CARD.w / 2, y: spot.y + CARD.h / 2 };
      const from = lay.chats[thread.chatId] || lay.owners[thread.askerId] || lay.project;
      const to = (thread.toId && lay.owners[thread.toId]) || lay.project;
      out.push({ id: `${thread.id}:ask`, kind: "thread-" + thread.kind, from, to: card, flow: "active" });
      out.push({ id: `${thread.id}:route`, kind: "thread-" + thread.kind, from: card, to, flow: "active" });
    }
    return out;
  }

  // What changed between two states. A null `prev` is the first state: nothing animates.
  function diff(prev, next) {
    const result = { newThreads: [], answered: [], removed: [], progressed: [], takeovers: [], newlyEnded: [] };
    if (!prev) return result;
    const prevThreads = new Map(prev.threads.map((thread) => [thread.id, thread]));
    const nextIds = new Set(next.threads.map((thread) => thread.id));
    for (const thread of next.threads) {
      const before = prevThreads.get(thread.id);
      if (!before && thread.status === "open") result.newThreads.push(thread);
      else if (before && before.status === "open" && thread.status === "answered") result.answered.push(thread);
    }
    for (const thread of prev.threads) if (thread.status === "open" && !nextIds.has(thread.id)) result.removed.push(thread.id);
    const prevChats = new Map(prev.chats.map((chat) => [chat.id, chat]));
    for (const chat of next.chats) {
      const before = prevChats.get(chat.id);
      if (before) {
        if (chat.lastProgressAt && chat.lastProgressAt !== before.lastProgressAt) result.progressed.push(chat.id);
        if (chat.state === "ended" && before.state !== "ended") result.newlyEnded.push(chat.id);
      }
      if (chat.resumedFrom && (!before || before.resumedFrom !== chat.resumedFrom)) result.takeovers.push({ from: chat.resumedFrom, to: chat.id });
    }
    return result;
  }

  // Greedy card placement in the world: beside the anchor, pushed down until clear of earlier cards.
  function placeCards(anchors, world) {
    const placed = [];
    return anchors.map((anchor) => {
      let x = anchor.x + 26;
      if (x + CARD.w > world.w - CARD.gap) x = anchor.x - 26 - CARD.w;
      x = clamp(x, CARD.gap, world.w - CARD.w - CARD.gap);
      let y = clamp(anchor.y - 20, CARD.gap, world.h - CARD.h - CARD.gap);
      const clash = (o) => x < o.x + CARD.w + CARD.gap && x + CARD.w + CARD.gap > o.x && y < o.y + CARD.h + CARD.gap && y + CARD.h + CARD.gap > o.y;
      for (let guard = 0; guard < 60 && placed.some(clash); guard++) {
        y += CARD.h + CARD.gap;
        if (y + CARD.h > world.h - CARD.gap) {
          y = CARD.gap;
          x = clamp(x + CARD.w + CARD.gap, CARD.gap, world.w - CARD.w - CARD.gap);
        }
      }
      const spot = { id: anchor.id, x, y };
      placed.push(spot);
      return spot;
    });
  }

  // ---- Zoom math: a view is { x, y, k }, the world's offset and scale inside the stage ----

  const clampScale = (k) => clamp(k, ZOOM.min, ZOOM.max);

  // Zoom by `factor`, keeping the world point under (px, py) where it is.
  function zoomAt(view, factor, px, py) {
    const k = clampScale(view.k * factor);
    const worldX = (px - view.x) / view.k;
    const worldY = (py - view.y) / view.k;
    return { x: px - worldX * k, y: py - worldY * k, k };
  }

  // The view that centres `bounds` in a vw x vh stage with padding.
  function fitView(bounds, vw, vh) {
    const bw = Math.max(1, bounds.maxX - bounds.minX);
    const bh = Math.max(1, bounds.maxY - bounds.minY);
    const k = clampScale(Math.min((vw - 2 * ZOOM.fitPad) / bw, (vh - 2 * ZOOM.fitPad) / bh));
    return { k, x: (vw - bw * k) / 2 - bounds.minX * k, y: (vh - bh * k) / 2 - bounds.minY * k };
  }

  // The box around everything drawn, including cards.
  function contentBounds(lay, cardSpots) {
    const pad = DIST.orbit * 0.6;
    const points = [lay.project, ...Object.values(lay.owners), ...Object.values(lay.chats), ...Object.values(lay.tasks), ...Object.values(lay.unassigned), ...Object.values(lay.decisions)];
    const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const p of points) {
      box.minX = Math.min(box.minX, p.x - pad);
      box.minY = Math.min(box.minY, p.y - pad);
      box.maxX = Math.max(box.maxX, p.x + pad);
      box.maxY = Math.max(box.maxY, p.y + pad);
    }
    for (const spot of Object.values(cardSpots || {})) {
      box.minX = Math.min(box.minX, spot.x);
      box.minY = Math.min(box.minY, spot.y);
      box.maxX = Math.max(box.maxX, spot.x + CARD.w);
      box.maxY = Math.max(box.maxY, spot.y + CARD.h);
    }
    return box;
  }

  // 0 far, 1 medium, 2 close, 3 very close.
  function detailLevel(k) {
    return k >= LOD.veryClose ? 3 : k >= LOD.close ? 2 : k >= LOD.medium ? 1 : 0;
  }

  function agoText(iso, nowMs) {
    const seconds = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
    if (!iso || Number.isNaN(seconds)) return "";
    if (seconds < 60) return "just now";
    if (seconds < 3600) return Math.round(seconds / 60) + " min ago";
    if (seconds < 86400) return Math.round(seconds / 3600) + " h ago";
    return Math.round(seconds / 86400) + " d ago";
  }

  // Markers along the axis from timeline.from to now. A label is shown only where it has room.
  function timelineLayout(timeline, nowMs, widthPx) {
    const from = Date.parse(timeline.from);
    const span = Math.max(1, nowMs - from);
    let lastLabelAt = -Infinity;
    return [...timeline.items]
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      .map((item) => {
        const pct = clamp(((Date.parse(item.at) - from) / span) * 100, 0, 100);
        const px = (pct / 100) * widthPx;
        const showLabel = px - lastLabelAt >= TIMELINE.labelGap && px + TIMELINE.labelGap <= widthPx + 40;
        if (showLabel) lastLabelAt = px;
        return { id: item.id, kind: item.kind, pct, label: item.label, showLabel };
      });
  }

  window.HackyMap = {
    normalize, pickChats, pickTasks, layout, links, threadLinks, diff, placeCards,
    zoomAt, fitView, contentBounds, detailLevel, clampScale, agoText, timelineLayout,
    MAX_CHATS, MAX_TASKS, ZOOM, LOD,
  };

  // ---- Rendering ----

  const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : { postMessage() {} };
  const root = document.getElementById("root") || document.body;
  const reduced = () => Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "onclick") node.onclick = value;
      else if (key === "text") node.textContent = value;
      else if (key === "class") node.className = value;
      else node.setAttribute(key, value);
    }
    for (const child of children) if (child) node.appendChild(child);
    return node;
  }

  function svg(tag, attrs = {}, text) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // The Hacky mascot, drawn inline because the panels may not load images.
  function logo() {
    const part = (tag, attrs) => svg(tag, attrs);
    const root = svg("svg", { class: "logo", viewBox: "0 0 128 128", role: "img", "aria-label": "Hacky" });
    for (const node of [
        part("rect", { width: 128, height: 128, rx: 28, fill: "#16132B" }),
        part("rect", { x: 15, y: 50, width: 6, height: 12, rx: 3, fill: "#4DE3F0" }),
        part("rect", { x: 59, y: 50, width: 6, height: 12, rx: 3, fill: "#4DE3F0" }),
        part("circle", { cx: 40, cy: 56, r: 22, fill: "#4DE3F0" }),
        part("circle", { cx: 33, cy: 54, r: 3.5, fill: "#16132B" }),
        part("circle", { cx: 47, cy: 54, r: 3.5, fill: "#16132B" }),
        part("rect", { x: 67, y: 36, width: 42, height: 40, rx: 13, fill: "#FF8A6B" }),
        part("rect", { x: 77, y: 52, width: 22, height: 8, rx: 4, fill: "#16132B" }),
        part("path", { d: "M64 12 L67.5 20.5 L76 24 L67.5 27.5 L64 36 L60.5 27.5 L52 24 L60.5 20.5 Z", fill: "#FFFFFF" }),
        part("rect", { x: 39, y: 66, width: 50, height: 46, rx: 15, fill: "#C8FF3D", stroke: "#16132B", "stroke-width": 4 }),
        part("circle", { cx: 53, cy: 85, r: 4, fill: "#16132B" }),
        part("circle", { cx: 75, cy: 85, r: 4, fill: "#16132B" }),
        part("path", { d: "M58 96 Q64 101 70 96", fill: "none", stroke: "#16132B", "stroke-width": 2.8, "stroke-linecap": "round" }),
      ]) root.appendChild(node);
      return root;
  }

  const title = el("h1", { text: "Hacky Map" });
  const zoomOut = el("button", { type: "button", class: "secondary", text: "−", "aria-label": "Zoom out", title: "Zoom out" });
  const zoomIn = el("button", { type: "button", class: "secondary", text: "+", "aria-label": "Zoom in", title: "Zoom in" });
  const fitButton = el("button", { type: "button", class: "secondary", text: "Fit", title: "Fit everything in view" });
  const legend = el("div", { class: "legend" }, [
    el("span", { class: "key question", text: "question" }),
    el("span", { class: "key assumption", text: "assumption" }),
    el("span", { class: "key agent", text: "agent to agent" }),
  ]);
  const bar = el("header", {}, [logo(), title, legend, el("div", { class: "zoom" }, [zoomOut, zoomIn, fitButton])]);

  const sceneSvg = svg("svg", { class: "scene", role: "img", "aria-label": "Team map" });
  const edges = svg("g");
  const tethers = svg("g");
  const nodes = svg("g");
  const fx = svg("g");
  sceneSvg.append(edges, tethers, nodes, fx);
  const cardLayer = el("div", { class: "cards" });
  const world = el("div", { class: "world lod-1" }, [sceneSvg, cardLayer]);
  const empty = el("p", { class: "empty", text: "Log in and join a team to see the map." });
  const stage = el("div", { class: "stage" }, [world, empty]);
  const timelineBox = el("footer", { class: "timeline" });
  root.append(bar, stage, timelineBox);

  let lastMap = null; // normalized map that is drawn
  let lay = null;
  let cardSpots = {};
  let view = { x: 0, y: 0, k: 1 };
  let moved = false; // the person has zoomed or panned, so don't refit by itself
  const cards = new Map(); // thread id -> { node, thread }

  const stageSize = () => ({ w: stage.clientWidth || 900, h: stage.clientHeight || 560 });
  const later = (ms, fn) => setTimeout(fn, ms);

  function setView(next) {
    view = { x: next.x, y: next.y, k: clampScale(next.k) };
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
    for (let level = 0; level <= 3; level++) world.classList.toggle("lod-" + level, level === detailLevel(view.k));
  }

  function fit() {
    if (!lay) return;
    const { w, h } = stageSize();
    setView(fitView(contentBounds(lay, cardSpots), w, h));
  }

  function zoomBy(factor, px, py) {
    const { w, h } = stageSize();
    moved = true;
    setView(zoomAt(view, factor, px === undefined ? w / 2 : px, py === undefined ? h / 2 : py));
  }

  zoomIn.onclick = () => zoomBy(ZOOM.step);
  zoomOut.onclick = () => zoomBy(1 / ZOOM.step);
  fitButton.onclick = () => {
    moved = false;
    fit();
  };
  stage.addEventListener("dblclick", (event) => {
    if (event.target.closest && event.target.closest(".card")) return;
    moved = false;
    fit();
  });
  stage.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      zoomBy(Math.exp(-event.deltaY * ZOOM.wheel), event.clientX - rect.left, event.clientY - rect.top);
    },
    { passive: false },
  );
  let drag = null;
  stage.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || (event.target.closest && event.target.closest(".card, button, input"))) return;
    drag = { x: event.clientX, y: event.clientY, view };
    stage.classList.add("dragging");
  });
  window.addEventListener("mousemove", (event) => {
    if (!drag) return;
    moved = true;
    setView({ ...drag.view, x: drag.view.x + event.clientX - drag.x, y: drag.view.y + event.clientY - drag.y });
  });
  window.addEventListener("mouseup", () => {
    drag = null;
    stage.classList.remove("dragging");
  });

  // Short-lived animated element in the effects layer; the layer is never rebuilt.
  function effect(node, ms) {
    if (reduced()) return;
    fx.appendChild(node);
    later(ms, () => node.remove());
  }

  const anchorOf = (chatId, ownerId) => lay.chats[chatId] || lay.owners[ownerId] || lay.project;

  function sendLine(from, to, kind) {
    if (from && to) effect(svg("line", { class: "fx-line " + kind, x1: from.x, y1: from.y, x2: to.x, y2: to.y }), 1800);
  }

  function pulseAt(at, cls) {
    if (at) effect(svg("circle", { class: "fx-pulse " + cls, cx: at.x, cy: at.y, r: SIZE.ring }), 1400);
  }

  function drawLink(layer, link) {
    layer.appendChild(svg("line", { class: `link ${link.kind} flow-${link.flow}`, x1: link.from.x, y1: link.from.y, x2: link.to.x, y2: link.to.y }));
  }

  // Text that appears from a given level of detail (lv1 medium, lv2 close, lv3 very close).
  function label(x, y, text, level, extra = "", anchor = "middle") {
    return svg("text", { class: `label lv${level} ${extra}`, x, y, "text-anchor": anchor }, text);
  }

  function draw(map) {
    const stats = map.stats;
    const totalTasks = stats.tasks.todo + stats.tasks.in_progress + stats.tasks.done;
    sceneSvg.setAttribute("width", lay.world.w);
    sceneSvg.setAttribute("height", lay.world.h);
    world.style.width = lay.world.w + "px";
    world.style.height = lay.world.h + "px";
    edges.replaceChildren();
    nodes.replaceChildren();
    for (const link of links(map, lay)) drawLink(edges, link);

    const p = lay.project;
    nodes.appendChild(svg("circle", { class: "project", cx: p.x, cy: p.y, r: SIZE.project }));
    if (totalTasks > 0) {
      const radius = SIZE.project + 8;
      const circumference = 2 * Math.PI * radius;
      nodes.appendChild(svg("circle", { class: "ring-track", cx: p.x, cy: p.y, r: radius }));
      nodes.appendChild(
        svg("circle", {
          class: "ring-done",
          cx: p.x,
          cy: p.y,
          r: radius,
          transform: `rotate(-90 ${p.x} ${p.y})`,
          "stroke-dasharray": `${(stats.tasks.done / totalTasks) * circumference} ${circumference}`,
        }),
      );
    }
    nodes.appendChild(label(p.x, p.y + 4, clip(map.project || "Project", 12), 1, "project-label"));
    nodes.appendChild(label(p.x, p.y + SIZE.project + 30, `${stats.activeChats} active chats · ${stats.openQuestions} open questions`, 1, "stat"));
    nodes.appendChild(label(p.x, p.y + SIZE.project + 46, `tasks: ${stats.tasks.todo} to do · ${stats.tasks.in_progress} in progress · ${stats.tasks.done} done · ${stats.decisions} decisions`, 2, "stat"));

    for (const owner of map.owners) {
      const spot = lay.owners[owner.id];
      nodes.appendChild(svg("circle", { class: "person" + (owner.me ? " me" : ""), cx: spot.x, cy: spot.y, r: SIZE.person }));
      nodes.appendChild(svg("text", { class: "initials", x: spot.x, y: spot.y + 4, "text-anchor": "middle" }, clip(owner.name, 3).toUpperCase()));
      nodes.appendChild(label(spot.x, spot.y - SIZE.person - 8, owner.name + (owner.me ? " (you)" : ""), 1, "person-label"));
      nodes.appendChild(label(spot.x, spot.y + SIZE.person + 14, `${owner.doneTasks} tasks done`, 2, "muted"));
      const more = [lay.hidden[owner.id] ? `+${lay.hidden[owner.id]} older chats` : "", lay.hiddenTasks[owner.id] ? `+${lay.hiddenTasks[owner.id]} more tasks` : ""].filter(Boolean).join(" · ");
      if (more) nodes.appendChild(label(spot.x, spot.y + SIZE.person + 28, more, 1, "muted"));
    }

    const now = Date.now();
    for (const chat of map.chats) {
      const spot = lay.chats[chat.id];
      if (!spot) continue;
      const dot = svg("circle", { class: "chat " + chat.state, cx: spot.x, cy: spot.y, r: SIZE.chat });
      dot.appendChild(svg("title", {}, [chat.task, chat.focus, chat.state].filter(Boolean).join(" – ")));
      nodes.appendChild(dot);
      nodes.appendChild(label(spot.x, spot.y + SIZE.chat + 12, clip(chat.task || chat.focus || "", 24), 1, "chat-label " + chat.state));
      nodes.appendChild(label(spot.x, spot.y + SIZE.chat + 25, clip(chat.focus || "", 38), 2, "muted " + chat.state));
      nodes.appendChild(label(spot.x, spot.y + SIZE.chat + 37, [chat.state, agoText(chat.lastSeenAt, now) && "seen " + agoText(chat.lastSeenAt, now)].filter(Boolean).join(" · "), 2, "muted " + chat.state));
    }

    for (const owner of map.owners) {
      for (const task of owner.tasks) {
        const spot = lay.tasks[task.id];
        if (!spot) continue;
        const dot = svg("rect", { class: "task " + task.status, x: spot.x - SIZE.task, y: spot.y - SIZE.task, width: SIZE.task * 2, height: SIZE.task * 2, rx: 2 });
        dot.appendChild(svg("title", {}, task.title));
        nodes.appendChild(dot);
        nodes.appendChild(label(spot.x, spot.y + SIZE.task + 12, clip(task.title, 28), 2, "task-label"));
        if (task.files && task.files.length) nodes.appendChild(label(spot.x, spot.y + SIZE.task + 24, clip(task.files.slice(0, 2).join(", "), 36), 3, "muted"));
      }
    }

    map.unassigned.forEach((task) => {
      const spot = lay.unassigned[task.id];
      const dot = svg("rect", { class: "task unassigned", x: spot.x - SIZE.small, y: spot.y - SIZE.small, width: SIZE.small * 2, height: SIZE.small * 2, rx: 2 });
      dot.appendChild(svg("title", {}, task.title + " (unassigned)"));
      nodes.appendChild(dot);
      nodes.appendChild(label(spot.x - SIZE.small - 6, spot.y + 4, clip(task.title, 30), 2, "task-label", "end"));
    });

    map.decisions.forEach((decision) => {
      const spot = lay.decisions[decision.id];
      const dot = svg("circle", { class: "decision", cx: spot.x, cy: spot.y, r: SIZE.small });
      dot.appendChild(svg("title", {}, decision.text));
      nodes.appendChild(dot);
      nodes.appendChild(label(spot.x + SIZE.small + 6, spot.y + 4, clip(decision.text, 44), 3, "decision-label", "start"));
    });
  }

  function renderCard(thread, map) {
    const asker = map.owners.find((owner) => owner.id === thread.askerId);
    const target = thread.toId ? map.owners.find((owner) => owner.id === thread.toId) : null;
    const open = thread.status === "open";
    const children = [
      el("div", { class: "card-head" }, [
        el("span", { class: "tag", text: thread.kind === "agent" ? "agent" : thread.kind }),
        el("span", { class: "who", text: `${asker ? asker.name : "?"} → ${target ? target.name : "whole team"}` }),
      ]),
      el("p", { class: "card-text lv2", text: thread.text }),
      thread.context ? el("p", { class: "card-context lv3", text: thread.context }) : null,
    ];
    if (!open) children.push(el("p", { class: "card-answer lv2", text: thread.answer ? "Answer: " + thread.answer : "Answered" }));
    else if (thread.mine && thread.kind !== "assumption") {
      const input = el("input", { type: "text", "aria-label": "Your answer", placeholder: "Your answer" });
      const send = () => {
        const text = input.value.trim();
        if (!text) return;
        vscode.postMessage({ type: thread.kind === "agent" ? "answerTeammate" : "answer", questionId: thread.id, text });
        input.value = "";
      };
      input.onkeydown = (event) => {
        if (event.key === "Enter") send();
      };
      children.push(el("div", { class: "row lv2" }, [input, el("button", { type: "button", text: "Send", onclick: send })]));
    } else if (thread.waiting) {
      children.push(el("p", { class: "card-context lv2", text: `${thread.waiting} waiting` }));
    }
    return el("div", { class: `card lv1 ${thread.kind}${open ? "" : " answered"}` }, children);
  }

  const sameCard = (a, b) => a.text === b.text && a.context === b.context && a.status === b.status && a.waiting === b.waiting && a.mine === b.mine;

  function syncCards(map, changes) {
    const open = map.threads.filter((thread) => thread.status === "open");
    const fresh = new Set(changes.newThreads.map((thread) => thread.id));
    const wanted = new Set(open.map((thread) => thread.id));
    // Answered threads: swap the card to its answer, then collapse it.
    for (const thread of changes.answered) {
      const known = cards.get(thread.id);
      if (known) {
        const done = renderCard(thread, map);
        known.node.replaceWith(done);
        done.style.left = known.node.style.left;
        done.style.top = known.node.style.top;
        done.style.width = CARD.w + "px";
        later(2500, () => {
          done.classList.add("collapsing");
          later(600, () => done.remove());
        });
        cards.delete(thread.id);
      }
      pulseAt(anchorOf(thread.chatId, thread.askerId), "answer");
      sendLine((thread.toId && lay.owners[thread.toId]) || lay.project, anchorOf(thread.chatId, thread.askerId), "answer");
    }
    for (const [id, card] of [...cards]) {
      if (!wanted.has(id)) {
        card.node.remove();
        cards.delete(id);
      }
    }
    for (const thread of open) {
      const known = cards.get(thread.id);
      if (known && sameCard(known.thread, thread)) continue;
      const node = renderCard(thread, map);
      if (known) {
        // Keep what the person is typing across refreshes.
        const typed = known.node.querySelector("input");
        const next = node.querySelector("input");
        if (typed && next) next.value = typed.value;
        known.node.replaceWith(node);
      } else {
        if (fresh.has(thread.id)) node.classList.add("entering");
        cardLayer.appendChild(node);
      }
      cards.set(thread.id, { node, thread });
    }
    const placed = placeCards(open.map((thread) => ({ id: thread.id, ...anchorOf(thread.chatId, thread.askerId) })), lay.world);
    cardSpots = {};
    for (const spot of placed) {
      cardSpots[spot.id] = spot;
      const card = cards.get(spot.id);
      if (!card) continue;
      card.node.style.left = spot.x + "px";
      card.node.style.top = spot.y + "px";
      card.node.style.width = CARD.w + "px";
    }
    for (const thread of changes.newThreads) {
      sendLine(anchorOf(thread.chatId, thread.askerId), thread.toId ? lay.owners[thread.toId] : lay.project, thread.kind);
    }
  }

  function drawTimeline(map) {
    timelineBox.replaceChildren();
    const stats = map.stats.tasks;
    const total = stats.todo + stats.in_progress + stats.done;
    const done = total ? Math.round((stats.done / total) * 100) : 0;
    const fill = el("div", { class: "bar-fill" });
    fill.style.width = done + "%";
    const progress = el("div", { class: "progress" }, [el("span", { class: "muted", text: `${stats.done} of ${total} tasks done` }), el("div", { class: "bar" }, [fill])]);
    timelineBox.appendChild(progress);
    if (!map.timeline) return;
    const width = Math.max(1, (timelineBox.clientWidth || 900) - 32);
    const now = Date.now();
    const axis = el("div", { class: "axis" });
    for (const marker of timelineLayout(map.timeline, now, width)) {
      const dot = el("span", { class: "marker " + marker.kind, title: marker.label });
      dot.style.left = marker.pct + "%";
      axis.appendChild(dot);
      if (marker.showLabel) {
        const text = el("span", { class: "marker-label " + marker.kind, text: clip(marker.label, TIMELINE.labelMax) });
        text.style.left = marker.pct + "%";
        axis.appendChild(text);
      }
    }
    const dates = el("div", { class: "dates muted" }, [
      el("span", { text: new Date(map.timeline.from).toLocaleString() }),
      el("span", { text: "now" }),
    ]);
    timelineBox.append(el("div", { class: "track" }, [axis, dates]));
  }

  function apply(input) {
    const map = normalize(input);
    const changes = diff(lastMap, map);
    const first = !lastMap;
    lastMap = map;
    empty.hidden = true;
    title.textContent = "Hacky Map – " + (map.project || "project");
    lay = layout(map);
    draw(map);
    syncCards(map, changes);
    tethers.replaceChildren();
    for (const link of threadLinks(map, lay, cardSpots)) drawLink(tethers, link);
    for (const id of changes.progressed) {
      const chat = map.chats.find((c) => c.id === id);
      pulseAt(lay.chats[id], "progress");
      // Progress flows chat to person to project.
      sendLine(lay.chats[id], chat && lay.owners[chat.ownerId], "progress");
      sendLine(chat && lay.owners[chat.ownerId], lay.project, "progress");
    }
    for (const id of changes.newlyEnded) pulseAt(lay.chats[id], "ended");
    for (const move of changes.takeovers) sendLine(lay.chats[move.from], lay.chats[move.to], "handoff");
    drawTimeline(map);
    if (first || !moved) fit();
  }

  function clear() {
    lastMap = null;
    lay = null;
    cardSpots = {};
    cardLayer.replaceChildren();
    cards.clear();
    for (const layer of [edges, tethers, nodes, fx]) layer.replaceChildren();
    timelineBox.replaceChildren();
  }

  window.addEventListener("resize", () => lastMap && !moved && fit());
  window.addEventListener("message", (event) => {
    const map = event.data && event.data.map;
    if (!map) {
      clear();
      empty.hidden = false;
      return;
    }
    apply(map);
  });

  vscode.postMessage({ type: "ready" });
})();
