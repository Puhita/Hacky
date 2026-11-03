// Hacky Map: people around the project, their chats on an orbit ring, and question threads as
// cards. Names, questions and answers come from teammates and agents, so they are untrusted:
// everything is rendered through textContent, never as HTML. The CSP forbids style attributes
// and blocks, so styling is classes in map.css plus element.style assignments from here.
(function () {
  const MAX_CHATS_PER_OWNER = 5;
  const CARD_W = 240;
  const CARD_H = 130;
  const SVG_NS = "http://www.w3.org/2000/svg";

  // ---- Pure functions (also exposed on window.HackyMap for tests) ----

  const STATE_RANK = { active: 0, idle: 1, ended: 2 };

  // The chats of one person worth drawing: live ones first, then newest, capped.
  function pickChats(chats, ownerId) {
    const mine = chats.filter((chat) => chat.ownerId === ownerId);
    mine.sort(
      (a, b) =>
        STATE_RANK[a.state] - STATE_RANK[b.state] || String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)),
    );
    return { shown: mine.slice(0, MAX_CHATS_PER_OWNER), hidden: Math.max(0, mine.length - MAX_CHATS_PER_OWNER) };
  }

  // Positions for the project, each person and each shown chat inside a w x h stage.
  function layout(map, w, h) {
    const cx = w / 2;
    const cy = h / 2;
    const ringR = Math.max(60, Math.min(w, h) * 0.3);
    const orbitR = Math.max(34, Math.min(70, ringR * 0.55));
    const owners = {};
    const chats = {};
    const hidden = {};
    const count = map.owners.length;
    map.owners.forEach((owner, index) => {
      const angle = -Math.PI / 2 + (2 * Math.PI * index) / Math.max(1, count);
      const x = count === 1 ? cx : cx + ringR * Math.cos(angle);
      const y = count === 1 ? cy - ringR : cy + ringR * Math.sin(angle);
      owners[owner.id] = { x, y, angle };
      const picked = pickChats(map.chats, owner.id);
      hidden[owner.id] = picked.hidden;
      const step = Math.min(0.95, (2 * Math.PI) / Math.max(1, picked.shown.length));
      picked.shown.forEach((chat, k) => {
        const a = angle + (k - (picked.shown.length - 1) / 2) * step;
        chats[chat.id] = { x: x + orbitR * Math.cos(a), y: y + orbitR * Math.sin(a) };
      });
    });
    return { project: { x: cx, y: cy }, owners, chats, hidden, orbitR };
  }

  // What changed between two map states. A null `prev` is the first state: nothing animates.
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
      if (chat.resumedFrom && (!before || before.resumedFrom !== chat.resumedFrom)) {
        result.takeovers.push({ from: chat.resumedFrom, to: chat.id });
      }
    }
    return result;
  }

  // Greedy card placement: next to the anchor, flipped left near the right edge, pushed down
  // until it no longer overlaps an earlier card, and kept inside the stage.
  function placeCards(anchors, w, h) {
    const placed = [];
    return anchors.map((anchor) => {
      let x = anchor.x + 26;
      if (x + CARD_W > w - 8) x = anchor.x - 26 - CARD_W;
      x = Math.max(8, Math.min(x, w - CARD_W - 8));
      let y = Math.max(8, Math.min(anchor.y - 20, h - CARD_H - 8));
      const clash = (other) => x < other.x + CARD_W && x + CARD_W > other.x && y < other.y + CARD_H && y + CARD_H > other.y;
      for (let guard = 0; guard < 40 && placed.some(clash); guard++) {
        y += CARD_H + 8;
        if (y + CARD_H > h - 8) {
          y = 8;
          x = Math.max(8, Math.min(x + CARD_W + 8, w - CARD_W - 8));
        }
      }
      const spot = { id: anchor.id, x, y };
      placed.push(spot);
      return spot;
    });
  }

  // A scripted fake team for the Demo button: no backend involved.
  function demoFrames() {
    const owners = [
      { id: "ana", name: "Ana", me: true },
      { id: "bo", name: "Bo", me: false },
      { id: "cy", name: "Cy", me: false },
    ];
    const chat = (id, ownerId, state, task, extra) => ({
      id, ownerId, state, focus: task, task, lastProgressAt: null,
      lastSeenAt: "2026-01-01T10:00:00Z", startedAt: "2026-01-01T09:00:00Z", resumedFrom: null, ...extra,
    });
    const base = [
      chat("a1", "ana", "active", "Checkout page"),
      chat("b1", "bo", "active", "Pricing API"),
      chat("c1", "cy", "idle", "Landing page"),
    ];
    const question = (extra) => ({
      id: "q1", kind: "question", askerId: "bo", chatId: "b1", toId: "ana", text: "Which discount do we show?",
      context: "Pricing API", status: "open", answer: null, waiting: 1, createdAt: "2026-01-01T10:01:00Z", mine: true, ...extra,
    });
    const frame = (at, chats, threads) => ({ at, map: { project: "Demo project", owners, chats, threads } });
    const progressed = base.map((c) => (c.id === "a1" ? { ...c, lastProgressAt: "2026-01-01T10:00:30Z" } : c));
    const asking = [question()];
    const assumed = [
      question(),
      { ...question({ id: "s1", kind: "assumption", askerId: "cy", chatId: "c1", toId: null, text: "Assuming 10% off", mine: false, waiting: 0 }) },
    ];
    const answered = [question({ status: "answered", answer: "17% off" }), assumed[1]];
    const ended = base.map((c) => (c.id === "b1" ? { ...c, state: "ended" } : c));
    const handedOff = [
      ...ended,
      chat("b2", "bo", "active", "Pricing API", { resumedFrom: "b1", lastProgressAt: "2026-01-01T10:05:00Z" }),
    ];
    const agentQ = {
      id: "p1", kind: "agent", askerId: "cy", chatId: "c1", toId: "bo", text: "What shape does /prices return?",
      context: "Landing page", status: "open", answer: null, waiting: 1, createdAt: "2026-01-01T10:06:00Z", mine: false,
    };
    return [
      frame(0, base, []),
      frame(1500, progressed, []),
      frame(3000, progressed, asking),
      frame(5500, progressed, assumed),
      frame(8000, progressed, answered),
      frame(10500, ended, answered),
      frame(12500, handedOff, answered),
      frame(15000, handedOff, [...answered, agentQ]),
    ];
  }

  window.HackyMap = { pickChats, layout, diff, placeCards, demoFrames, MAX_CHATS_PER_OWNER };

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

  const clip = (text, max) => (text && text.length > max ? text.slice(0, max - 1) + "…" : text || "");

  const title = el("h1", { text: "Hacky Map" });
  const demoButton = el("button", { type: "button", class: "secondary", text: "Demo" });
  const legend = el("div", { class: "legend" }, [
    el("span", { class: "key question", text: "question" }),
    el("span", { class: "key assumption", text: "assumption" }),
    el("span", { class: "key agent", text: "agent to agent" }),
  ]);
  const bar = el("header", {}, [title, legend, demoButton]);
  const sceneSvg = svg("svg", { class: "scene", role: "img", "aria-label": "Team map" });
  const edges = svg("g");
  const nodes = svg("g");
  const fx = svg("g");
  sceneSvg.append(edges, nodes, fx);
  const cardLayer = el("div", { class: "cards" });
  const empty = el("p", { class: "empty", text: "Log in and join a team to see the map." });
  const stage = el("div", { class: "stage" }, [sceneSvg, cardLayer, empty]);
  root.append(bar, stage);

  let lastMap = null; // what is drawn
  let lastReal = null; // latest map from the extension
  let spots = {}; // layout of the last draw
  const cards = new Map(); // thread id -> { node, thread }
  let demoTimers = null;

  const size = () => ({ w: stage.clientWidth || 900, h: stage.clientHeight || 560 });

  function later(ms, fn) {
    return setTimeout(fn, ms);
  }

  // Short-lived animated element in the effects layer; the layer is never rebuilt.
  function effect(node, ms) {
    if (reduced()) return;
    fx.appendChild(node);
    later(ms, () => node.remove());
  }

  const anchorOf = (chatId, ownerId) => spots.chats[chatId] || spots.owners[ownerId] || spots.project;

  function sendLine(from, to, kind) {
    if (!from || !to) return;
    effect(svg("line", { class: "fx-line " + kind, x1: from.x, y1: from.y, x2: to.x, y2: to.y }), 1800);
  }

  function pulseAt(at, cls) {
    if (at) effect(svg("circle", { class: "fx-pulse " + cls, cx: at.x, cy: at.y, r: 14 }), 1400);
  }

  function draw(map) {
    const { w, h } = size();
    sceneSvg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    spots = layout(map, w, h);
    edges.replaceChildren();
    nodes.replaceChildren();
    const project = spots.project;
    nodes.appendChild(svg("circle", { class: "project", cx: project.x, cy: project.y, r: 30 }));
    nodes.appendChild(svg("text", { class: "label project-label", x: project.x, y: project.y + 4, "text-anchor": "middle" }, clip(map.project || "Project", 14)));
    for (const owner of map.owners) {
      const spot = spots.owners[owner.id];
      edges.appendChild(svg("line", { class: "edge", x1: project.x, y1: project.y, x2: spot.x, y2: spot.y }));
      nodes.appendChild(svg("circle", { class: "orbit", cx: spot.x, cy: spot.y, r: spots.orbitR }));
      nodes.appendChild(svg("circle", { class: "person" + (owner.me ? " me" : ""), cx: spot.x, cy: spot.y, r: 16 }));
      nodes.appendChild(svg("text", { class: "label", x: spot.x, y: spot.y + 4, "text-anchor": "middle" }, clip(owner.name, 3).toUpperCase()));
      nodes.appendChild(svg("text", { class: "caption", x: spot.x, y: spot.y + 30, "text-anchor": "middle" }, owner.name + (owner.me ? " (you)" : "")));
      if (spots.hidden[owner.id]) {
        nodes.appendChild(svg("text", { class: "caption", x: spot.x, y: spot.y - 24, "text-anchor": "middle" }, `+${spots.hidden[owner.id]} older chats`));
      }
    }
    for (const chat of map.chats) {
      const spot = spots.chats[chat.id];
      if (!spot) continue;
      const owner = spots.owners[chat.ownerId];
      edges.appendChild(svg("line", { class: "edge chat-edge " + chat.state, x1: owner.x, y1: owner.y, x2: spot.x, y2: spot.y }));
      const dot = svg("circle", { class: "chat " + chat.state, cx: spot.x, cy: spot.y, r: 8 });
      dot.appendChild(svg("title", {}, [chat.task, chat.focus, chat.state].filter(Boolean).join(" – ")));
      nodes.appendChild(dot);
      nodes.appendChild(svg("text", { class: "caption chat-caption " + chat.state, x: spot.x, y: spot.y + 20, "text-anchor": "middle" }, clip(chat.task || chat.focus || "", 22)));
    }
    // A taken-over chat flows into the chat that resumed it.
    for (const chat of map.chats) {
      const from = chat.resumedFrom && spots.chats[chat.resumedFrom];
      const to = spots.chats[chat.id];
      if (from && to) edges.appendChild(svg("line", { class: "flow", x1: from.x, y1: from.y, x2: to.x, y2: to.y }));
    }
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
      el("p", { class: "card-text", text: thread.text }),
      thread.context ? el("p", { class: "card-context", text: thread.context }) : null,
    ];
    if (!open) children.push(el("p", { class: "card-answer", text: thread.answer ? "Answer: " + thread.answer : "Answered" }));
    else if (thread.mine && thread.kind !== "assumption") {
      const input = el("input", { type: "text", "aria-label": "Your answer", placeholder: "Your answer" });
      const send = () => {
        const text = input.value.trim();
        if (!text) return;
        const type = thread.kind === "agent" ? "answerTeammate" : "answer";
        if (demoTimers) answerInDemo(thread.id, text);
        else vscode.postMessage({ type, questionId: thread.id, text });
        input.value = "";
      };
      input.onkeydown = (event) => {
        if (event.key === "Enter") send();
      };
      children.push(el("div", { class: "row" }, [input, el("button", { type: "button", text: "Send", onclick: send })]));
    } else if (thread.waiting) {
      children.push(el("p", { class: "card-context", text: `${thread.waiting} waiting` }));
    }
    return el("div", { class: `card ${thread.kind}${open ? "" : " answered"}` }, children);
  }

  function syncCards(map, changes) {
    const { w, h } = size();
    const open = map.threads.filter((thread) => thread.status === "open");
    const fresh = new Set(changes.newThreads.map((thread) => thread.id));
    const wanted = new Set(open.map((thread) => thread.id));
    // Answered threads: swap the card to its answer, then collapse it.
    for (const thread of changes.answered) {
      const known = cards.get(thread.id);
      if (known) {
        known.node.replaceWith((known.node = renderCard(thread, map)));
        const done = known.node;
        later(2500, () => {
          done.classList.add("collapsing");
          later(600, () => done.remove());
        });
        cards.delete(thread.id);
      }
      pulseAt(anchorOf(thread.chatId, thread.askerId), "answer");
      sendLine(spots.owners[thread.toId] || spots.project, anchorOf(thread.chatId, thread.askerId), "answer");
    }
    for (const [id, card] of [...cards]) {
      if (!wanted.has(id)) {
        card.node.remove();
        cards.delete(id);
      }
    }
    for (const thread of open) {
      const known = cards.get(thread.id);
      const node = renderCard(thread, map);
      if (known && sameCard(known.thread, thread)) continue;
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
    const placed = placeCards(
      open.map((thread) => ({ id: thread.id, ...anchorOf(thread.chatId, thread.askerId) })),
      w,
      h,
    );
    for (const spot of placed) {
      const card = cards.get(spot.id);
      if (!card) continue;
      card.node.style.left = spot.x + "px";
      card.node.style.top = spot.y + "px";
      card.node.style.width = CARD_W + "px";
    }
    for (const thread of changes.newThreads) {
      sendLine(anchorOf(thread.chatId, thread.askerId), thread.toId ? spots.owners[thread.toId] : spots.project, thread.kind);
    }
  }

  const sameCard = (a, b) =>
    a.text === b.text && a.context === b.context && a.status === b.status && a.waiting === b.waiting && a.mine === b.mine;

  function apply(map) {
    const changes = diff(lastMap, map);
    lastMap = map;
    empty.hidden = true;
    title.textContent = "Hacky Map – " + (map.project || "project");
    draw(map);
    for (const id of changes.progressed) pulseAt(spots.chats[id], "progress");
    for (const id of changes.newlyEnded) pulseAt(spots.chats[id], "ended");
    for (const move of changes.takeovers) sendLine(spots.chats[move.from], spots.chats[move.to], "handoff");
    syncCards(map, changes);
  }

  function reset() {
    lastMap = null;
    cardLayer.replaceChildren();
    cards.clear();
    fx.replaceChildren();
  }

  // ---- Demo ----

  function stopDemo() {
    if (!demoTimers) return;
    demoTimers.forEach(clearTimeout);
    demoTimers = null;
    demoButton.textContent = "Demo";
    reset();
    if (lastReal) apply(lastReal);
    else {
      sceneSvg.setAttribute("viewBox", "0 0 1 1");
      edges.replaceChildren();
      nodes.replaceChildren();
      empty.hidden = false;
    }
  }

  function startDemo() {
    reset();
    demoButton.textContent = "Stop demo";
    const frames = demoFrames();
    demoTimers = frames.map((frame) => later(frame.at, () => apply(frame.map)));
    // Loop: restart a little after the last frame.
    demoTimers.push(later(frames[frames.length - 1].at + 6000, () => {
      if (demoTimers) {
        stopDemo();
        startDemo();
      }
    }));
  }

  // Answering a card in the demo only changes the picture.
  function answerInDemo(id, text) {
    if (!lastMap) return;
    apply({ ...lastMap, threads: lastMap.threads.map((thread) => (thread.id === id ? { ...thread, status: "answered", answer: text } : thread)) });
  }

  demoButton.onclick = () => (demoTimers ? stopDemo() : startDemo());

  // ---- Messages ----

  window.addEventListener("resize", () => lastMap && apply({ ...lastMap }));
  window.addEventListener("message", (event) => {
    const map = event.data && event.data.map;
    lastReal = map || null;
    if (demoTimers) return;
    if (!map) {
      reset();
      edges.replaceChildren();
      nodes.replaceChildren();
      empty.hidden = false;
      return;
    }
    apply(map);
  });

  vscode.postMessage({ type: "ready" });
})();
