// Hacky Board: the team's tasks, messages, people and activity in one wide editor tab.
// Everything here comes from teammates and agents, so it is untrusted: it is rendered through
// textContent, never as HTML.
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");
  root.classList.add("hk");
  let lastState = null;
  let pending = false;

  // ---- Remembered choices ----

  const saved = vscode.getState() ?? {};
  const TAB_IDS = ["tasks", "sprints", "messages", "team", "project", "files", "activity"];
  let tab = TAB_IDS.includes(saved.tab) ? saved.tab : "tasks";
  let messageFilter = saved.messageFilter === "all" ? "all" : "mine";
  let activityFilter = typeof saved.activityFilter === "string" ? saved.activityFilter : "";
  const folds = { ...(saved.folds ?? {}) };
  // "" shows everyone's tasks, otherwise only the tasks of the person with that name.
  let taskFilter = typeof saved.taskFilter === "string" ? saved.taskFilter : "";
  // "" shows every area, otherwise only tasks with that area label.
  let areaFilter = typeof saved.areaFilter === "string" ? saved.areaFilter : "";
  // The Project tab hides finished and dropped ideas and bugs until asked.
  let showClosedItems = saved.showClosedItems === true;
  // "" shows everyone in the Files tab, otherwise only the files that person touched.
  let fileFilter = typeof saved.fileFilter === "string" ? saved.fileFilter : "";
  const persist = () => vscode.setState({ tab, messageFilter, activityFilter, taskFilter, areaFilter, showClosedItems, fileFilter, folds });

  const drafts = new Map(); // half-typed text, by field id
  const rejecting = new Set(); // assumption ids whose reject box is open
  const changing = new Set(); // decision ids whose change box is open
  const seen = new Set(); // ids already shown, so only new cards slide in
  let firstRender = true;

  // ---- Small helpers ----

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "onclick" || key === "onsubmit" || key === "onkeydown") node[key] = value;
      else if (key === "text") node.textContent = value;
      else if (key === "class") node.className = value;
      else node.setAttribute(key, value);
    }
    for (const child of children) if (child) node.appendChild(child);
    return node;
  }

  const SVG_NS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs = {}, children = []) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    for (const child of children) node.appendChild(child);
    return node;
  }

  const ICONS = {
    board: ["M2 4.5A1.5 1.5 0 013.5 3h9A1.5 1.5 0 0114 4.5v7a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5z", "M6 3v10M10 3v10"],
    map: ["M5.2 4.8l5.6-.6M4.5 6.4l2.8 4.2M11.6 5.4L8.8 10.6", "M5.2 5a1.6 1.6 0 11-3.2 0 1.6 1.6 0 013.2 0zM14 4a1.6 1.6 0 11-3.2 0A1.6 1.6 0 0114 4zM9.6 12A1.6 1.6 0 116.4 12a1.6 1.6 0 013.2 0z"],
    copy: ["M5.5 5.5h6a1.5 1.5 0 011.5 1.5v6a1.5 1.5 0 01-1.5 1.5h-6A1.5 1.5 0 014 13V7a1.5 1.5 0 011.5-1.5z", "M10.5 5.5V4A1.5 1.5 0 009 2.5H4A1.5 1.5 0 002.5 4v5A1.5 1.5 0 004 10.5h1.5"],
    inbox: ["M2.5 9.5l1.7-5.3h7.6l1.7 5.3v3h-11z", "M2.5 9.5h3.2l.8 1.5h3l.8-1.5h3.2"],
    team: ["M8.2 5.5a2.2 2.2 0 11-4.4 0 2.2 2.2 0 014.4 0z", "M2 13c.4-2.4 1.9-3.6 4-3.6s3.6 1.2 4 3.6", "M13.2 6a1.7 1.7 0 11-3.4 0 1.7 1.7 0 013.4 0z", "M11 9.6c1.9 0 2.8 1 3.2 2.9"],
    activity: ["M1.5 8h3l2-4.5 3 9 2-4.5h3"],
    chevron: ["M4 6l4 4 4-4"],
    check: ["M3 8.5l3.2 3L13 4.5"],
    close: ["M4 4l8 8M12 4l-8 8"],
    plus: ["M8 3v10M3 8h10"],
    sprint: ["M13.5 8A5.5 5.5 0 113.6 4.7", "M12.8 2.2v2.6h-2.6", "M8 5v3l2 1.5"],
  };
  function icon(name, className = "") {
    const attrs = { viewBox: "0 0 16 16", "aria-hidden": "true" };
    if (className) attrs.class = className;
    return svgEl("svg", attrs, ICONS[name].map((d) => svgEl("path", { d })));
  }

  // The Hacky mascot, drawn inline because the panels may not load images.
  function logo(className = "logo") {
    const shape = (tag, attrs) => svgEl(tag, attrs);
    return svgEl("svg", { class: className, viewBox: "0 0 128 128", role: "img", "aria-label": "Hacky" }, [
      shape("rect", { width: "128", height: "128", rx: "28", fill: "#16132B" }),
      shape("rect", { x: "15", y: "50", width: "6", height: "12", rx: "3", fill: "#4DE3F0" }),
      shape("rect", { x: "59", y: "50", width: "6", height: "12", rx: "3", fill: "#4DE3F0" }),
      shape("circle", { cx: "40", cy: "56", r: "22", fill: "#4DE3F0" }),
      shape("circle", { cx: "33", cy: "54", r: "3.5", fill: "#16132B" }),
      shape("circle", { cx: "47", cy: "54", r: "3.5", fill: "#16132B" }),
      shape("rect", { x: "67", y: "36", width: "42", height: "40", rx: "13", fill: "#FF8A6B" }),
      shape("rect", { x: "77", y: "52", width: "22", height: "8", rx: "4", fill: "#16132B" }),
      shape("path", { d: "M64 12 L67.5 20.5 L76 24 L67.5 27.5 L64 36 L60.5 27.5 L52 24 L60.5 20.5 Z", fill: "#FFFFFF" }),
      shape("rect", { x: "39", y: "66", width: "50", height: "46", rx: "15", fill: "#C8FF3D", stroke: "#16132B", "stroke-width": "4" }),
      shape("circle", { cx: "53", cy: "85", r: "4", fill: "#16132B" }),
      shape("circle", { cx: "75", cy: "85", r: "4", fill: "#16132B" }),
      shape("path", { d: "M58 96 Q64 101 70 96", fill: "none", stroke: "#16132B", "stroke-width": "2.8", "stroke-linecap": "round" }),
    ]);
  }

  const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const people = (count) => (count === 1 ? "1 person" : `${count} people`);

  function age(iso) {
    const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
    if (Number.isNaN(minutes)) return "";
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m`;
    if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
    return `${Math.round(minutes / 1440)}d`;
  }

  const initials = (name) =>
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0].toUpperCase())
      .join("") || "?";

  // Status glyphs: colour and shape, drawn as SVG so they sit exactly in the middle. kinds: needs, wait, work, done, idle.
  const glyph = (kind) => {
    const part = (tag, attrs) => svgEl(tag, attrs);
    const parts = {
      needs: [part("circle", { class: "g-fill", cx: 8, cy: 8, r: 8 }), part("rect", { class: "g-cut", x: 7, y: 3.6, width: 2, height: 5.4, rx: 1 }), part("circle", { class: "g-cut", cx: 8, cy: 11.6, r: 1.15 })],
      wait: [part("circle", { class: "g-ring", cx: 8, cy: 8, r: 7.2 }), part("rect", { class: "g-fill", x: 5.3, y: 5, width: 1.8, height: 6, rx: 0.9 }), part("rect", { class: "g-fill", x: 8.9, y: 5, width: 1.8, height: 6, rx: 0.9 })],
      work: [part("circle", { class: "g-ring faint", cx: 8, cy: 8, r: 6.5 }), part("path", { class: "g-ring", d: "M8 1.5A6.5 6.5 0 0 1 14.5 8" })],
      done: [part("circle", { class: "g-fill", cx: 8, cy: 8, r: 8 }), part("path", { class: "g-tick", d: "M4.8 8.3L7 10.5L11.3 5.8" })],
      idle: [part("circle", { class: "g-ring", cx: 8, cy: 8, r: 7.2 }), part("path", { class: "g-dash", d: "M5 8H11" })],
    };
    return svgEl("svg", { class: `gl ${kind}`, viewBox: "0 0 16 16", "aria-hidden": "true" }, parts[kind] ?? parts.idle);
  };
  const hex = (kind, count, size = "sm") => el("span", { class: `hx ${kind} ${size}`.trim() }, [el("b", { text: String(count) })]);
  const count = (n) => el("span", { class: "cnt", text: String(n) });
  const avatar = (member, index, size = "") =>
    el("span", { class: `av a${(index % 4) + 1} ${size}`.trim() }, [
      document.createTextNode(initials(member.name)),
      member.chats === undefined ? null : el("i", { class: `pd ${member.chats > 0 ? "live" : "idle"}` }),
    ]);

  function draftArea(id, label, placeholder = label) {
    const area = el("textarea", { "aria-label": label, placeholder, rows: "2", id });
    area.value = drafts.get(id) ?? "";
    area.oninput = () => drafts.set(id, area.value);
    return area;
  }

  function sendDraft(area, buildMessage) {
    if (area.value.trim() === "") return;
    drafts.delete(area.id);
    vscode.postMessage(buildMessage(area.value));
  }

  function isNew(id) {
    const fresh = !firstRender && !seen.has(id);
    seen.add(id);
    return fresh;
  }

  const isOpen = (key, dflt) => (key in folds ? folds[key] : dflt);

  // A card that eases open. The choice is remembered per key.
  function foldCard(key, defaultOpen, { kind, headline, meta, hot = false, fresh = false }, bodyChildren) {
    const open = isOpen(key, defaultOpen);
    const wrap = el("article", { class: `card${hot ? " hot" : ""}${fresh ? " fresh" : ""}${open ? " open" : ""}` });
    const head = el("button", { type: "button", class: "card-h", "aria-expanded": String(open) }, [
      glyph(kind),
      el("span", { class: "ch" }, [el("span", { class: "hl cl2", text: headline }), meta ? el("span", { class: "meta" }, meta) : null]),
      icon("chevron", "chev"),
    ]);
    const body = el("div", { class: `fold${open ? " open" : ""}` }, [el("div", { class: "fold-in" }, bodyChildren)]);
    head.onclick = () => {
      const next = !wrap.classList.contains("open");
      folds[key] = next;
      persist();
      wrap.classList.toggle("open", next);
      body.classList.toggle("open", next);
      head.setAttribute("aria-expanded", String(next));
    };
    wrap.append(head, body);
    return wrap;
  }

  const group = (title, total, children) =>
    el("div", { class: "grp" }, [el("div", { class: "gh" }, [el("span", { text: title }), total === undefined ? null : count(total)]), ...children]);
  const empty = (text) => el("p", { class: "empty", text });
  const tag = (text) => el("span", { class: "tag", text });
  const badge = () => el("span", { class: "badge" }, [el("i"), document.createTextNode("For you")]);

  function button(label, className, onclick, iconName) {
    return Object.assign(el("button", { type: "button", class: `btn ${className}` }, [iconName ? icon(iconName) : null, document.createTextNode(label)]), { onclick });
  }

  function openMap() {
    vscode.postMessage({ type: "openMap" });
  }

  // ---- Derived numbers ----

  const incomingOpen = (state) => state.agentChat.filter((thread) => thread.direction === "incoming" && thread.answer === null);
  const needCount = (state) => state.inbox.filter((question) => question.routed_to_me).length + incomingOpen(state).length;
  const liveChats = (state) => state.pulse.reduce((sum, member) => sum + member.chats, 0);

  // ---- Tasks ----

  const AREAS = ["art", "code", "design", "audio"];

  const TASK_COLUMNS = [
    ["todo", "To do", "idle"],
    ["in_progress", "In progress", "work"],
    ["done", "Done", "done"],
  ];

  function renderTask(task, kind, memberIndex, sprintName) {
    return el("article", { class: "tc" }, [
      el("div", { class: "tc-top" }, [glyph(kind), el("span", { class: "hl cl2", text: task.title })]),
      task.area || sprintName
        ? el("div", { class: "files" }, [
            task.area ? el("span", { class: `area area-${task.area}`, text: task.area }) : null,
            sprintName ? el("span", { class: "stag tr", text: sprintName }) : null,
          ])
        : null,
      (task.files ?? []).length > 0 ? el("div", { class: "files" }, task.files.map((file) => el("span", { class: "file tr", text: file }))) : null,
      el("div", { class: "tc-foot" }, [
        task.owner
          ? el("span", { class: "who" }, [el("span", { class: `av sm a${(memberIndex(task.owner) % 4) + 1}`, text: initials(task.owner) }), el("b", { text: task.owner })])
          : el("span", { text: "Unclaimed" }),
      ]),
    ]);
  }

  function renderTasks(state) {
    const title = el("input", { type: "text", class: "in", id: "new-task", name: "title", "aria-label": "New task", placeholder: "What needs doing?" });
    const area = el("select", { class: "in", id: "new-task-area", name: "area", "aria-label": "Area" }, [
      el("option", { value: "", text: "No area" }),
      ...AREAS.map((name) => el("option", { value: name, text: name })),
    ]);
    const sprints = state.sprints ?? [];
    const openSprints = sprints.filter((sprint) => sprint.status !== "closed").sort((a, b) => (a.status === "active" ? -1 : b.status === "active" ? 1 : 0));
    const sprintNames = new Map(sprints.map((sprint) => [sprint.id, sprint.name]));
    const sprint =
      openSprints.length > 0
        ? el("select", { class: "in", id: "new-task-sprint", name: "sprint", "aria-label": "Sprint" }, [
            el("option", { value: "", text: "Backlog" }),
            ...openSprints.map((item) => el("option", { value: item.id, text: item.status === "active" ? `${item.name} (running)` : item.name })),
          ])
        : null;
    const add = () => {
      if (title.value.trim() === "") return;
      vscode.postMessage({ type: "addTask", title: title.value, ...(area.value && { area: area.value }), ...(sprint && sprint.value && { sprintId: sprint.value }) });
    };
    title.onkeydown = (event) => event.key === "Enter" && add();
    const names = state.pulse.map((member) => member.name);
    const memberIndex = (name) => Math.max(0, names.indexOf(name));
    if (taskFilter && !names.includes(taskFilter)) taskFilter = "";
    const countFor = (name) => state.tasks.filter((task) => task.owner === name).length;
    const chip = (value, label, total) =>
      el(
        "button",
        {
          type: "button",
          class: `chip${taskFilter === value ? " on" : ""}`,
          "aria-pressed": String(taskFilter === value),
          onclick: () => {
            taskFilter = value;
            persist();
            render(lastState);
          },
        },
        [document.createTextNode(label), el("span", { class: "chip-n", text: String(total) })],
      );
    const areaChip = (value, label) =>
      el(
        "button",
        {
          type: "button",
          class: `chip${areaFilter === value ? " on" : ""}`,
          "aria-pressed": String(areaFilter === value),
          onclick: () => {
            areaFilter = value;
            persist();
            render(lastState);
          },
        },
        [document.createTextNode(label), el("span", { class: "chip-n", text: String(state.tasks.filter((task) => !value || task.area === value).length) })],
      );
    const shown = state.tasks.filter((task) => (!taskFilter || task.owner === taskFilter) && (!areaFilter || task.area === areaFilter));
    return el("div", { class: "bc-in" }, [
      el("div", { class: "addtask" }, [
        el("div", { class: "f1" }, [el("label", { for: "new-task", text: "New task" }), title]),
        el("div", {}, [el("label", { for: "new-task-area", text: "Area" }), area]),
        sprint ? el("div", {}, [el("label", { for: "new-task-sprint", text: "Sprint" }), sprint]) : null,
        button("Add task", "cta", add, "plus"),
      ]),
      names.length > 1
        ? el("div", { class: "chips", role: "group", "aria-label": "Filter tasks by person" }, [
            chip("", "Everyone", state.tasks.length),
            ...names.map((name) => chip(name, name, countFor(name))),
          ])
        : null,
      state.tasks.some((task) => task.area)
        ? el("div", { class: "chips", role: "group", "aria-label": "Filter tasks by area" }, [areaChip("", "All areas"), ...AREAS.map((name) => areaChip(name, name))])
        : null,
      el(
        "div",
        { class: "kan" },
        TASK_COLUMNS.map(([status, name, kind]) => {
          const tasks = shown.filter((task) => task.status === status);
          return el("section", { class: "col column" }, [
            el("div", { class: "col-h" }, [glyph(kind), el("span", { text: name }), count(tasks.length)]),
            ...(tasks.length === 0 ? [empty("Nothing here.")] : tasks.map((task) => renderTask(task, kind, memberIndex, task.sprintId ? sprintNames.get(task.sprintId) : null))),
          ]);
        }),
      ),
    ]);
  }

  // ---- Messages ----

  function renderQuestion(question) {
    const key = `q-${question.id}`;
    const answer = draftArea(`answer-${question.id}`, "Your answer", "Answer once. Every waiting agent gets it.");
    return foldCard(
      key,
      true,
      {
        kind: "needs",
        headline: question.text,
        hot: question.routed_to_me,
        fresh: isNew(key),
        meta: [
          question.routed_to_me ? badge() : null,
          tag("Question"),
          el("span", { text: question.asked_by_name }),
          el("span", { text: `${plural(question.waiting, "agent")} waiting` }),
          el("span", { text: age(question.created_at) }),
        ],
      },
      [
        el("div", { class: "fb" }, [
          question.context ? el("p", { class: "ctx", text: question.context }) : null,
          answer,
          el("div", { class: "row" }, [
            el("span", { class: "hint", text: `Reaches ${plural(question.waiting, "agent")}` }),
            button("Send answer", "pri", () => sendDraft(answer, (text) => ({ type: "answer", questionId: question.id, text }))),
          ]),
        ]),
      ],
    );
  }

  // A question between agents that is waiting for this person.
  function renderIncomingThread(thread) {
    const key = `t-${thread.id}`;
    const answer = draftArea(`peer-${thread.id}`, "Your answer", "Reply to the agent");
    return foldCard(
      key,
      true,
      {
        kind: "needs",
        headline: thread.question,
        hot: true,
        fresh: isNew(key),
        meta: [badge(), tag("Agent"), el("span", { text: `${thread.other}'s agent asks` }), el("span", { text: age(thread.created_at) })],
      },
      [
        el("div", { class: "fb" }, [
          thread.context ? el("p", { class: "ctx", text: thread.context }) : null,
          answer,
          el("div", { class: "row" }, [
            el("span", { class: "hint", text: `Reaches ${thread.other}'s agent` }),
            button("Send answer to agent", "pri", () => sendDraft(answer, (text) => ({ type: "answerTeammate", questionId: thread.id, text }))),
          ]),
        ]),
      ],
    );
  }

  function renderAssumption(assumption) {
    const key = `a-${assumption.id}`;
    const reason = draftArea(`reason-${assumption.id}`, "Why it's wrong, or what to do instead", "Why? The agent will read this.");
    const rejectOpen = rejecting.has(assumption.id);
    return el("article", { class: `card${isNew(key) ? " fresh" : ""}` }, [
      el("div", { class: "as-h" }, [
        glyph("wait"),
        el("span", { class: "ch" }, [
          el("span", { class: "hl cl2", text: assumption.text }),
          el("span", { class: "meta" }, [el("span", { text: `Assumed by ${assumption.author}, for: ${assumption.question}` })]),
        ]),
      ]),
      el("div", { class: "as-a" }, [
        button("Confirm", "sec", () => vscode.postMessage({ type: "confirmAssumption", assumptionId: assumption.id }), "check"),
        Object.assign(button("Reject…", "ghost", () => {
          if (rejecting.has(assumption.id)) rejecting.delete(assumption.id);
          else rejecting.add(assumption.id);
          render(lastState);
        }, "close"), {}),
      ]),
      rejectOpen
        ? el("div", { class: "fb2" }, [
            reason,
            el("div", { class: "row" }, [
              el("button", {
                type: "button",
                class: "lnk",
                text: "Cancel",
                onclick: () => {
                  rejecting.delete(assumption.id);
                  render(lastState);
                },
              }),
              button("Reject and notify", "pri", () => sendDraft(reason, (text) => ({ type: "rejectAssumption", assumptionId: assumption.id, reason: text }))),
            ]),
          ])
        : null,
    ]);
  }

  // Read-only: answered threads, and ones this person's agent is waiting on.
  function renderThreadCard(thread) {
    const open = thread.answer === null;
    const incoming = thread.direction === "incoming";
    const who = incoming ? `${thread.other}'s agent asks` : `Your agent asked ${thread.other}`;
    return el("div", { class: "thr" }, [
      el("div", { class: "thr-h" }, [glyph(open ? "wait" : "done"), el("b", { text: who }), el("span", { class: "sp" }), open ? null : tag("Read-only"), el("span", { text: age(thread.created_at) })]),
      el("div", { class: "hl plain", text: thread.question }),
      thread.context ? el("div", { class: "thr-a", text: thread.context }) : null,
      open
        ? el("div", { class: "thr-a", text: `Waiting for ${thread.other}.` })
        : el("div", { class: "thr-a" }, [el("span", { text: thread.answer }), el("span", { class: "muted", text: thread.answered_by_agent ? "Answered by their agent." : "Answered by a person." })]),
    ]);
  }

  function renderDecision(decision) {
    const open = changing.has(decision.id);
    const replacement = open ? draftArea(`decision-${decision.id}`, "The new decision") : null;
    return el("div", { class: "dec" }, [
      el("div", { class: "dec-t", text: decision.text }),
      decision.question ? el("div", { class: "dec-m", text: decision.question }) : null,
      el("div", { class: "dec-m", text: `Decided by ${decision.author} · ${age(decision.created_at)}` }),
      el("div", { class: "dec-a" }, [
        el("button", {
          type: "button",
          class: "lnk",
          text: open ? "Cancel" : "Change",
          onclick: () => {
            if (changing.has(decision.id)) changing.delete(decision.id);
            else changing.add(decision.id);
            render(lastState);
          },
        }),
        el("button", { type: "button", class: "lnk", text: "Withdraw", onclick: () => vscode.postMessage({ type: "withdrawDecision", decisionId: decision.id }) }),
      ]),
      replacement,
      open ? button("Replace", "pri sm", () => sendDraft(replacement, (text) => ({ type: "changeDecision", decisionId: decision.id, text }))) : null,
    ]);
  }

  function renderMessages(state) {
    const mine = messageFilter === "mine";
    const questions = mine ? state.inbox.filter((question) => question.routed_to_me) : state.inbox;
    const incoming = incomingOpen(state);
    const waiting = mine ? [...questions.map(renderQuestion), ...incoming.map(renderIncomingThread)] : [...questions.map(renderQuestion), ...incoming.map(renderIncomingThread)];
    const waitingCount = questions.length + incoming.length;
    const rest = state.agentChat.filter((thread) => !incoming.includes(thread));
    const need = needCount(state);
    const segment = (value, label, badgeNode) =>
      el("button", { type: "button", class: messageFilter === value ? "on" : "", "aria-pressed": String(messageFilter === value), onclick: () => {
        messageFilter = value;
        persist();
        render(lastState);
      } }, [document.createTextNode(label), badgeNode]);

    const main = [
      group(mine ? "Waiting for you" : "Questions", waitingCount, waiting.length > 0 ? waiting : [empty(mine ? "Nothing is waiting for you." : "No open questions.")]),
      group("Agents are proceeding on", state.assumptions.length, state.assumptions.length > 0 ? [el("div", { class: "two" }, state.assumptions.map(renderAssumption))] : [empty("No agent is working on an assumption.")]),
      mine ? null : group("Agent chats", rest.length, rest.length > 0 ? rest.map(renderThreadCard) : [empty("No agent has asked another agent anything yet.")]),
    ];

    return el("div", { class: "bc-in" }, [
      el("div", { class: "bar" }, [
        el("div", {}, [el("h2", { text: "Messages" }), el("div", { class: "sub", text: `${plural(need, "question")} wait on you · ${plural(state.assumptions.length, "assumption")} to review` })]),
        el("span", { class: "sp" }),
        el("div", { class: "seg", role: "group", "aria-label": "Filter messages" }, [
          segment("mine", "Mine", need > 0 ? hex("needs", need) : null),
          segment("all", "Everything", null),
        ]),
      ]),
      el("div", { class: "cols" }, [
        el("div", { class: "main" }, main.filter(Boolean)),
        el("aside", { class: "rail", "aria-label": "Decisions" }, [
          el("h3", {}, [el("span", { text: "Decisions" }), count(state.decisions.length)]),
          ...(state.decisions.length === 0 ? [empty("No decisions yet.")] : state.decisions.map(renderDecision)),
          el("p", { class: "hint rail-note", text: "Changing or withdrawing a decision notifies every agent." }),
        ]),
      ]),
    ]);
  }

  // ---- Team ----

  // A picture of the team: people as hexes, their live chats around them, open questions in orange.
  function miniMap(state) {
    const members = state.pulse.slice(0, 5);
    const links = [];
    const nodes = [];
    const labels = [];
    const step = members.length > 1 ? 220 / (members.length - 1) : 0;
    const centre = members.length > 1 ? 40 : 150;
    const yAt = (index) => [54, 40, 66][index % 3];
    members.forEach((member, index) => {
      const x = centre + index * step;
      const y = yAt(index);
      const points = [[0, -21], [18.2, -10.5], [18.2, 10.5], [0, 21], [-18.2, 10.5], [-18.2, -10.5]].map(([dx, dy]) => `${x + dx},${y + dy}`).join(" ");
      nodes.push(svgEl("polygon", { class: "p", points }));
      labels.push(svgEl("text", { x: String(x), y: String(y + 5) }, [document.createTextNode(initials(member.name))]));
      for (let dot = 0; dot < Math.min(member.chats, 2); dot += 1) {
        const dx = x + (dot === 0 ? -34 : 34);
        const dy = y + (index % 2 === 0 ? -34 : 34);
        links.push(svgEl("path", { d: `M${x} ${y}L${dx} ${dy}` }));
        nodes.push(svgEl("circle", { class: "n-work", cx: String(dx), cy: String(dy), r: "6" }));
      }
      if (index > 0) links.push(svgEl("path", { d: `M${centre + (index - 1) * step} ${yAt(index - 1)}L${x} ${y}` }));
    });
    if (needCount(state) > 0 && members.length > 0) {
      links.push(svgEl("path", { class: "q", d: `M150 90L${centre} 56` }));
      nodes.push(svgEl("circle", { class: "n-q", cx: "150", cy: "88", r: "11" }));
      labels.push(svgEl("text", { class: "n-q-t", x: "150", y: "92" }, [document.createTextNode("?")]));
    }
    return svgEl(
      "svg",
      { class: "mini", viewBox: "0 0 300 104", preserveAspectRatio: "xMidYMid meet", role: "img", "aria-label": `Map preview: ${people(state.pulse.length)}, ${plural(liveChats(state), "chat")}, ${plural(needCount(state), "open question")}` },
      [svgEl("g", { class: "lk" }, links), ...nodes, ...labels],
    );
  }

  const CHAT_GLYPH = { active: "work", idle: "idle", ended: "done" };

  function renderPerson(member, index, chatsOf) {
    const mapChats = chatsOf(member.name).filter((chat) => chat.state !== "ended").slice(0, 5);
    const rows =
      mapChats.length > 0
        ? mapChats.map((chat) => ({ kind: CHAT_GLYPH[chat.state] ?? "idle", name: chat.state === "active" ? "Active" : "Idle", text: chat.focus ?? chat.task ?? "No focus yet", when: chat.lastSeenAt ? age(chat.lastSeenAt) : "" }))
        : member.focus.map((focus) => ({ kind: "work", name: "Now", text: focus, when: "" }));
    const live = member.chats > 0;
    return el("article", { class: "pc" }, [
      el("div", { class: "pc-h" }, [
        avatar(member, index),
        el("div", { class: "grow" }, [
          el("div", { class: "pc-n tr", text: member.me ? `${member.name} (you)` : member.name }),
          el("div", { class: "hint", text: live ? `${plural(member.chats, "chat")} active` : "No chat active" }),
        ]),
        button("Show on Map", "ghost sm", openMap),
      ]),
      rows.length > 0
        ? el("ul", {}, rows.map((row) =>
            el("li", { class: "chat" }, [glyph(row.kind), el("div", { class: "ch" }, [
              el("div", { class: "cn" }, [el("span", { class: "tr", text: row.name }), el("span", { class: "age", text: row.when })]),
              el("div", { class: "now cl2", text: row.text }),
            ])]),
          ))
        : null,
      member.updates > 0 || member.latest.length > 0
        ? el("div", {}, [
            el("div", { class: "gh gh-tight" }, [el("span", { text: "Recent progress" })]),
            member.updates > 0 ? el("p", { class: "hint", text: `${plural(member.updates, "update")} in the last hour:` }) : null,
            el("ul", { class: "pg" }, member.latest.map((summary) => el("li", {}, [el("span", { class: "grow", text: summary })]))),
          ])
        : null,
    ]);
  }

  function renderTeam(state) {
    const owners = new Map(((state.map && state.map.owners) || []).map((owner) => [owner.name, owner]));
    const chatsOf = (name) => {
      const owner = owners.get(name);
      return owner ? ((state.map && state.map.chats) || []).filter((chat) => chat.ownerId === owner.id) : [];
    };
    const waiting = state.inbox.reduce((sum, question) => sum + question.waiting, 0);
    return el("div", { class: "bc-in" }, [
      el("div", { class: "hero" }, [
        el("div", { class: "hero-l" }, [
          el("h2", { text: "Hacky Map" }),
          el("p", { text: "See every person, chat and open question as a live graph. Zoom in, follow the flowing links, and scrub the work timeline." }),
          el("div", { class: "stats" }, [
            el("span", { class: "st" }, [hex("work", liveChats(state)), document.createTextNode("working")]),
            el("span", { class: "st" }, [hex(waiting > 0 ? "wait" : "", waiting), document.createTextNode("waiting")]),
            el("span", { class: "st" }, [hex(needCount(state) > 0 ? "needs" : "", needCount(state)), document.createTextNode("open questions")]),
          ]),
          el("div", { class: "hero-a" }, [button("Open map", "pri lg", openMap), el("span", { class: "hint", text: "Opens in its own editor tab" })]),
        ]),
        miniMap(state),
      ]),
      state.pulse.length === 0 ? empty("Nobody is on the team yet.") : el("div", { class: "people" }, state.pulse.map((member, index) => renderPerson(member, index, chatsOf))),
    ]);
  }

  // ---- Activity ----

  const HOUR = 3_600_000;

  function renderActivity(state) {
    const authors = [...new Set(state.feed.map((item) => item.author))];
    if (activityFilter && !authors.includes(activityFilter)) activityFilter = "";
    const chip = (value, label) =>
      el("button", { type: "button", class: `chip${activityFilter === value ? " on" : ""}`, "aria-pressed": String(activityFilter === value), text: label, onclick: () => {
        activityFilter = value;
        persist();
        render(lastState);
      } });
    const items = state.feed.filter((item) => !activityFilter || item.author === activityFilter);
    const rows = [];
    let divided = false;
    items.forEach((item, index) => {
      const recent = Date.now() - new Date(item.created_at).getTime() < HOUR;
      if (!recent && !divided && index > 0) {
        rows.push(el("div", { class: "div", text: "Earlier" }));
        divided = true;
      }
      rows.push(
        el("div", { class: `ev${recent ? " new" : ""}` }, [
          el("span", { class: "tm", text: new Date(item.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }),
          glyph(recent ? "work" : "done"),
          el("span", { class: "grow" }, [
            el("b", { text: item.author }),
            document.createTextNode(` ${item.summary}`),
            (item.files ?? []).length > 0 ? el("span", { class: "files-line tr", text: item.files.join(", ") }) : null,
          ]),
          el("span", { class: "age", text: age(item.created_at) }),
        ]),
      );
    });
    return el("div", { class: "bc-in" }, [
      el("div", { class: "bar" }, [
        el("div", {}, [el("h2", { text: "Activity" }), el("div", { class: "sub", text: "What everyone's agents did" })]),
        el("span", { class: "sp" }),
        authors.length > 1 ? el("div", { class: "chips", role: "group", "aria-label": "Filter activity" }, [chip("", "Everyone"), ...authors.map((author) => chip(author, author))]) : null,
      ]),
      rows.length === 0 ? empty("No activity yet.") : el("div", { class: "tl" }, rows),
    ]);
  }

  // ---- Project ----

  const SEVERITIES = ["low", "medium", "high"];

  function renderOverview(state) {
    const { overview } = state.project;
    const field = (id, label, saved) => {
      const area = el("textarea", { "aria-label": label, placeholder: label, rows: "7", id, name: id });
      area.value = drafts.has(id) ? drafts.get(id) : saved;
      area.oninput = () => drafts.set(id, area.value);
      return el("div", { class: "f1" }, [el("label", { for: id, text: label }), area]);
    };
    const idea = field("ov-idea", "The idea: what are we building and for whom?", overview.idea);
    const architecture = field("ov-architecture", "The architecture: how is it put together?", overview.architecture);
    const save = () => {
      const message = { type: "saveOverview", idea: idea.querySelector("textarea").value, architecture: architecture.querySelector("textarea").value };
      drafts.delete("ov-idea");
      drafts.delete("ov-architecture");
      vscode.postMessage(message);
    };
    return el("section", { class: "ov" }, [
      el("div", { class: "bar" }, [
        el("div", {}, [el("h2", { text: "Overview" }), el("div", { class: "sub", text: "Shared by the team. Agents read the start of it each session, but only people can edit it." })]),
        el("span", { class: "sp" }),
        overview.updatedAt ? el("span", { class: "muted", text: `Last edited by ${overview.updatedBy ?? "a teammate"}, ${age(overview.updatedAt)} ago` }) : null,
      ]),
      el("div", { class: "ov-fields" }, [idea, architecture]),
      el("div", { class: "row" }, [button("Save overview", "cta", save)]),
    ]);
  }

  function renderItem(item) {
    const closed = item.status !== "open";
    const post = (message) => () => vscode.postMessage(message);
    const actions = [
      item.taskId ? el("span", { class: "muted", text: "On the board" }) : button("Make task", "sec", post({ type: "projectItemToTask", itemId: item.id }), "plus"),
      closed
        ? button("Reopen", "sec", post({ type: "setProjectItemStatus", itemId: item.id, status: "open" }))
        : button("Done", "sec", post({ type: "setProjectItemStatus", itemId: item.id, status: "done" }), "check"),
      closed ? null : button("Drop", "sec", post({ type: "setProjectItemStatus", itemId: item.id, status: "dropped" }), "close"),
    ];
    return el("article", { class: `tc pitem${closed ? " closed" : ""}` }, [
      el("div", { class: "tc-top" }, [
        item.severity ? el("span", { class: `sev sev-${item.severity}`, text: item.severity }) : null,
        el("span", { class: "hl cl2", text: item.title }),
      ]),
      item.details ? el("p", { class: "muted pdetails", text: item.details }) : null,
      el("div", { class: "tc-foot" }, [
        el("span", { text: `${item.author ?? "A teammate"} \u00b7 ${age(item.createdAt)}${closed ? ` \u00b7 ${item.status}` : ""}` }),
        el("span", { class: "sp" }),
        ...actions,
      ]),
    ]);
  }

  function renderItemColumn(state, kind, heading) {
    const title = el("input", { type: "text", class: "in", id: `new-${kind}`, name: "title", "aria-label": `New ${kind}`, placeholder: kind === "bug" ? "What is wrong?" : "What could we build?" });
    const details = el("textarea", { class: "in", id: `new-${kind}-details`, name: "details", "aria-label": `${heading} details`, placeholder: "Details (optional)", rows: "2" });
    const severity = kind === "bug" ? el("select", { class: "in", name: "severity", "aria-label": "Severity" }, [el("option", { value: "", text: "Severity" }), ...SEVERITIES.map((name) => el("option", { value: name, text: name }))]) : null;
    const add = () => {
      if (title.value.trim() === "") return;
      vscode.postMessage({ type: "addProjectItem", kind, title: title.value, details: details.value, ...(severity && severity.value && { severity: severity.value }) });
    };
    title.onkeydown = (event) => event.key === "Enter" && add();
    const all = state.project.items.filter((item) => item.kind === kind);
    const open = all.filter((item) => item.status === "open");
    const closed = all.filter((item) => item.status !== "open");
    return el("section", { class: "col column" }, [
      el("div", { class: "col-h" }, [el("span", { text: heading }), count(open.length)]),
      el("div", { class: "pform" }, [title, details, el("div", { class: "row" }, [severity, button(`Add ${kind}`, "cta", add, "plus")])]),
      ...(open.length === 0 ? [empty(kind === "bug" ? "No open bugs." : "No open ideas.")] : open.map(renderItem)),
      closed.length > 0
        ? button(showClosedItems ? "Hide finished" : `Show finished (${closed.length})`, "sec", () => {
            showClosedItems = !showClosedItems;
            persist();
            render(lastState);
          })
        : null,
      ...(showClosedItems ? closed.map(renderItem) : []),
    ]);
  }

  // ---- GitHub and the same-project check ----

  const ghLink = (url, text, className = "gh-a") =>
    url
      ? el("button", { type: "button", class: `linkish ${className}`, title: url, onclick: () => vscode.postMessage({ type: "openGithubLink", url }) }, [document.createTextNode(text)])
      : el("span", { class: className, text });

  function renderGithub(state) {
    const github = state.github;
    if (!github) return null;
    const lead = state.team.role === "lead";
    const head = (sub, extra) =>
      el("div", { class: "bar" }, [el("div", {}, [el("h2", { text: "GitHub" }), el("div", { class: "sub", text: sub })]), el("span", { class: "sp" }), ...extra]);

    const tokenInput = () => {
      const input = el("input", { type: "password", class: "in", id: "gh-token", name: "token", autocomplete: "off", "aria-label": "GitHub token", placeholder: "GitHub token (github_pat_…)" });
      const save = () => {
        if (input.value.trim() === "") return;
        vscode.postMessage({ type: "saveGithubToken", token: input.value });
        input.value = "";
      };
      input.onkeydown = (event) => event.key === "Enter" && save();
      return el("div", { class: "row gh-token" }, [input, button("Save token", "sec", save)]);
    };

    // The person's own GitHub account: signed in, waiting for the code, or not signed in.
    const tokenRow = () => {
      if (github.account || github.hasToken) {
        const who = github.account?.login ? ` as ${github.account.login}` : "";
        return el("div", { class: "row gh-token" }, [
          el("span", { class: "muted", text: github.account?.via === "token" ? `Using your GitHub token${who}, saved on this computer only.` : `Signed in to GitHub${who}. The sign-in stays on this computer.` }),
          button("Sign out of GitHub", "sec", () => vscode.postMessage({ type: "removeGithubToken" }), "close"),
        ]);
      }
      if (github.signIn) {
        return el("div", { class: "gh-device", role: "status" }, [
          el("p", { text: "Enter this code on GitHub to finish signing in:" }),
          el("div", { class: "row" }, [
            el("code", { class: "gh-code", text: github.signIn.userCode }),
            button("Copy code", "sec", () => navigator.clipboard?.writeText(github.signIn.userCode), "copy"),
            button("Open GitHub", "cta", () => vscode.postMessage({ type: "openGithubLink", url: github.signIn.verificationUri })),
            button("Cancel", "sec", () => vscode.postMessage({ type: "githubCancelSignIn" }), "close"),
          ]),
          el("p", { class: "muted", text: "Waiting for you to approve on GitHub…" }),
        ]);
      }
      if (!github.canSignIn) return tokenInput();
      const other = el("details", { class: "gh-other" }, [el("summary", { text: "Use a token instead" }), tokenInput()]);
      return el("div", { class: "gh-signin" }, [
        el("div", { class: "row" }, [
          button("Sign in with GitHub", "cta", () => vscode.postMessage({ type: "githubSignIn" })),
          el("span", { class: "muted", text: "To see private repositories and pick from your own." }),
        ]),
        other,
      ]);
    };

    if (!github.link) {
      const input = el("input", { type: "text", class: "in", id: "gh-repo", name: "repo", "aria-label": "GitHub repository", placeholder: github.folderRepo ?? "owner/name or github.com link" });
      const link = () => vscode.postMessage({ type: "linkGithub", repo: input.value.trim() || github.folderRepo || "" });
      input.onkeydown = (event) => event.key === "Enter" && link();
      const repos = github.myRepos ?? [];
      // A lead who signed in picks straight from their own repositories.
      const picker = lead && repos.length > 0
        ? el("div", { class: "gh-pick" }, [
            el("h3", { text: "Your repositories" }),
            el("ul", {}, repos.slice(0, 12).map((repo) =>
              el("li", {}, [
                el("span", { class: "grow", text: repo.fullName }),
                repo.private ? el("span", { class: "tag", text: "private" }) : null,
                repo.pushedAt ? el("span", { class: "muted", text: age(repo.pushedAt) }) : null,
                button("Link", "sec", () => vscode.postMessage({ type: "linkGithub", repo: repo.fullName }), "plus"),
              ]),
            )),
          ])
        : null;
      return el("section", { class: "gh" }, [
        head("Link the repository your group works in. Everyone sees its pull requests and commits, and Hacky checks that everyone's folder is a copy of it.", []),
        tokenRow(),
        picker,
        lead
          ? el("div", { class: "row" }, [input, button(github.folderRepo && !input.value ? `Link ${github.folderRepo}` : "Link repository", "cta", link, "plus")])
          : el("p", { class: "muted", text: github.folderRepo ? `A group lead can link it. Your folder pushes to ${github.folderRepo}.` : "A group lead can link the group's repository." }),
      ]);
    }

    const overview = github.overview;
    const meta = [];
    if (overview) {
      meta.push(overview.repo.private ? "private" : "public", `default branch ${overview.repo.defaultBranch}`, `${overview.pulls.length}${overview.pulls.length === 10 ? "+" : ""} open pull requests`);
      if (overview.repo.pushedAt) meta.push(`last push ${age(overview.repo.pushedAt)} ago`);
    }
    const list = (heading, items, row) => el("div", { class: "gh-list" }, [el("h3", { text: heading }), items.length === 0 ? empty("None.") : el("ul", {}, items.map((item) => el("li", {}, row(item))))]);
    return el("section", { class: "gh" }, [
      head(`Linked by ${github.link.linkedBy ?? "a teammate"}, ${age(github.link.linkedAt)} ago.`, [
        button(github.status === "loading" ? "Loading…" : "Refresh", "sec", () => vscode.postMessage({ type: "loadGithub" })),
        lead ? button("Unlink", "sec", () => vscode.postMessage({ type: "unlinkGithub" }), "close") : null,
      ]),
      el("div", { class: "gh-repo" }, [
        ghLink(overview?.repo.url || `https://github.com/${github.link.repo}`, github.link.repo, "gh-name"),
        overview?.repo.description ? el("span", { class: "muted", text: overview.repo.description }) : null,
      ]),
      meta.length > 0 ? el("div", { class: "muted gh-meta", text: meta.join(" · ") }) : null,
      github.error ? el("p", { class: "error", role: "alert", text: github.error }) : null,
      overview
        ? el("div", { class: "kan two gh-cols" }, [
            list("Open pull requests", overview.pulls, (pull) => [
              ghLink(pull.url, `#${pull.number} ${pull.title}`),
              el("span", { class: "muted", text: ` ${pull.draft ? "draft · " : ""}${pull.author} · ${age(pull.updatedAt)}` }),
            ]),
            list("Latest commits", overview.commits, (commit) => [
              ghLink(commit.url, commit.sha, "gh-sha"),
              el("span", { text: ` ${commit.message}` }),
              el("span", { class: "muted", text: ` ${commit.author} · ${age(commit.date)}` }),
            ]),
          ])
        : null,
      tokenRow(),
    ]);
  }

  const VERDICT_TEXT = { same: "Same project", different: "Different project", unknown: "Can't tell", missing: "No folder yet" };

  function renderSameProject(state) {
    const check = state.github?.check;
    if (!check) return null;
    const summary =
      check.status === "mismatch"
        ? "Someone is working in a different project. Check their folder before you merge work."
        : check.status === "ok"
          ? "Everyone who opened Hacky is in the same project."
          : check.basis === "none"
            ? "Nobody's folder is a git repository yet, so Hacky can only compare folder names."
            : "Not everyone can be compared yet.";
    const names = (state.members ?? []).map((member) => member.name);
    return el("section", { class: `same ${check.status}` }, [
      el("div", { class: "bar" }, [
        el("div", {}, [
          el("h2", { text: "Same project?" }),
          el("div", { class: "sub", text: check.basis === "github" ? "Each person's open folder, compared with the linked repository." : "Each person's open folder, compared by git history and remote. Link GitHub above for a firmer check." }),
        ]),
      ]),
      el("p", { class: `same-sum ${check.status}`, role: check.status === "mismatch" ? "alert" : "status", text: summary }),
      el("ul", { class: "same-rows" }, check.rows.map((row) =>
        el("li", { class: `same-row v-${row.verdict}` }, [
          avatar({ name: row.name }, Math.max(0, names.indexOf(row.name)), "sm"),
          el("b", { text: row.me ? `${row.name} (you)` : row.name }),
          el("span", { class: `verdict v-${row.verdict}`, text: VERDICT_TEXT[row.verdict] ?? row.verdict }),
          el("span", { class: "muted grow", text: row.reason }),
        ]),
      )),
    ]);
  }

  function renderProject(state) {
    return el("div", { class: "bc-in" }, [
      renderGithub(state),
      renderSameProject(state),
      renderOverview(state),
      el("div", { class: "kan two" }, [renderItemColumn(state, "idea", "Ideas"), renderItemColumn(state, "bug", "Bugs")]),
    ]);
  }

  // ---- Files ----

  const MAX_AVATARS = 4;

  // Folders and files from the reported paths, with who touched what. Folders come first, then by name.
  function buildTree(touches) {
    const rootNode = { name: "", path: "", children: new Map(), people: new Map(), lastAt: "" };
    for (const touch of touches) {
      let node = rootNode;
      const parts = touch.path.split("/").filter(Boolean);
      let path = "";
      parts.forEach((part, index) => {
        path = path ? `${path}/${part}` : part;
        if (!node.children.has(part)) node.children.set(part, { name: part, path, children: new Map(), people: new Map(), lastAt: "", file: index === parts.length - 1 });
        node = node.children.get(part);
        const seenAt = node.people.get(touch.person);
        if (!seenAt || touch.lastAt > seenAt) node.people.set(touch.person, touch.lastAt);
        if (touch.lastAt > node.lastAt) node.lastAt = touch.lastAt;
      });
    }
    return rootNode;
  }

  const sortedChildren = (node) => [...node.children.values()].sort((a, b) => Number(Boolean(a.file)) - Number(Boolean(b.file)) || a.name.localeCompare(b.name));

  function renderFiles(state) {
    const touches = state.fileTouches ?? [];
    const names = state.pulse.map((member) => member.name);
    const memberIndex = (name) => Math.max(0, names.indexOf(name));
    const people = [...new Set(touches.map((touch) => touch.person))].sort();
    if (fileFilter && !people.includes(fileFilter)) fileFilter = "";
    const shown = touches.filter((touch) => !fileFilter || touch.person === fileFilter);
    const chip = (value, label, total) =>
      el(
        "button",
        {
          type: "button",
          class: `chip${fileFilter === value ? " on" : ""}`,
          "aria-pressed": String(fileFilter === value),
          onclick: () => {
            fileFilter = value;
            persist();
            render(lastState);
          },
        },
        [document.createTextNode(label), el("span", { class: "chip-n", text: String(total) })],
      );
    const stack = (node) => {
      const who = [...node.people.entries()].sort((a, b) => b[1].localeCompare(a[1])).map(([name]) => name);
      return el("span", { class: "stack", role: "img", "aria-label": `Touched by ${who.join(", ")}`, title: who.join(", ") }, [
        ...who.slice(0, MAX_AVATARS).map((name) => avatar({ name }, memberIndex(name), "sm")),
        who.length > MAX_AVATARS ? el("span", { class: "more", text: `+${who.length - MAX_AVATARS}` }) : null,
      ]);
    };
    const rows = [];
    const walk = (node, depth) => {
      for (const child of sortedChildren(node)) {
        if (child.file) {
          rows.push(el("div", { class: "frow file", "data-depth": String(depth) }, [el("span", { class: "fname", text: child.name }), el("span", { class: "sp" }), stack(child), el("span", { class: "age", text: age(child.lastAt) })]));
        } else {
          const key = `f:${child.path}`;
          const open = isOpen(key, depth < 1);
          rows.push(
            el(
              "button",
              {
                type: "button",
                class: `frow folder${open ? " open" : ""}`,
                "data-depth": String(depth),
                "aria-expanded": String(open),
                onclick: () => {
                  folds[key] = !open;
                  persist();
                  render(lastState);
                },
              },
              [icon("chevron", "chev"), el("span", { class: "fname", text: `${child.name}/` }), el("span", { class: "sp" }), stack(child), el("span", { class: "age", text: age(child.lastAt) })],
            ),
          );
          if (open) walk(child, depth + 1);
        }
      }
    };
    walk(buildTree(shown), 0);
    return el("div", { class: "bc-in" }, [
      el("div", { class: "bar" }, [
        el("div", {}, [el("h2", { text: "Files" }), el("div", { class: "sub", text: "Files agents edited in the last week, as they reported them. This is not anyone's real folder." })]),
        el("span", { class: "sp" }),
        people.length > 1 ? el("div", { class: "chips", role: "group", "aria-label": "Filter files by person" }, [chip("", "Everyone", touches.length), ...people.map((name) => chip(name, name, touches.filter((touch) => touch.person === name).length))]) : null,
      ]),
      rows.length === 0
        ? empty("No edits reported yet. Click Connect this folder in the sidebar to install the hook, then start a new Claude Code chat.")
        : el("div", { class: "ftree" }, rows),
    ]);
  }

  // ---- Sprints ----

  const STATUS_KIND = { todo: "idle", in_progress: "work", done: "done" };
  const STATUS_LABEL = { todo: "to do", in_progress: "in progress", done: "done" };

  function formatDay(day) {
    if (!day) return "";
    const date = new Date(`${day}T00:00:00`);
    return Number.isNaN(date.getTime()) ? day : date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }

  function sprintDates(sprint) {
    if (sprint.startsOn && sprint.endsOn) return `${formatDay(sprint.startsOn)} – ${formatDay(sprint.endsOn)}`;
    if (sprint.startsOn) return `from ${formatDay(sprint.startsOn)}`;
    if (sprint.endsOn) return `until ${formatDay(sprint.endsOn)}`;
    return "No dates";
  }

  // Whole days left until the end date, today included. Negative once it is past.
  function daysLeft(endsOn) {
    if (!endsOn) return null;
    const end = new Date(`${endsOn}T00:00:00`);
    if (Number.isNaN(end.getTime())) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((end.getTime() - today.getTime()) / 86_400_000) + 1;
  }

  function progressBar(done, total) {
    const pct = total === 0 ? 0 : Math.round((done / total) * 100);
    const fill = el("i");
    fill.style.width = `${pct}%`;
    return el("div", { class: "sprog" }, [
      el("div", { class: "sprog-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(total), "aria-valuenow": String(done), "aria-label": `${done} of ${total} tasks done` }, [fill]),
      el("span", { class: "muted", text: `${done} of ${plural(total, "task")} done` }),
    ]);
  }

  function sprintTaskRow(task, memberIndex, actions) {
    const kind = STATUS_KIND[task.status] ?? "idle";
    return el("div", { class: "srow" }, [
      glyph(kind),
      el("span", { class: "grow cl2", text: task.title }),
      task.area ? el("span", { class: `area area-${task.area}`, text: task.area }) : null,
      task.owner ? el("span", { class: `av sm a${(memberIndex(task.owner) % 4) + 1}`, title: task.owner, text: initials(task.owner) }) : el("span", { class: "muted", text: "Unclaimed" }),
      ...actions,
    ]);
  }

  const removeButton = (task) => button("Remove", "sec", () => vscode.postMessage({ type: "setTaskSprint", taskId: task.id, sprintId: null }));

  // A select that moves the task into a sprint as soon as one is picked.
  function moveSelect(task, sprints) {
    const select = el("select", { class: "in", "aria-label": `Add to sprint: ${task.title}` }, [
      el("option", { value: "", text: "Add to sprint" }),
      ...sprints.map((sprint) => el("option", { value: sprint.id, text: sprint.status === "active" ? `${sprint.name} (running)` : sprint.name })),
    ]);
    select.onchange = () => select.value && vscode.postMessage({ type: "setTaskSprint", taskId: task.id, sprintId: select.value });
    return select;
  }

  function renderSprintForm() {
    const field = (id, label, input, className = "") => el("div", { class: className }, [el("label", { for: id, text: label }), input]);
    const name = el("input", { type: "text", class: "in", id: "sprint-name", name: "name", placeholder: "Sprint 1", maxlength: "120" });
    const starts = el("input", { type: "date", class: "in", id: "sprint-start", name: "startsOn" });
    const ends = el("input", { type: "date", class: "in", id: "sprint-end", name: "endsOn" });
    const goal = el("textarea", { class: "in", id: "sprint-goal", name: "goal", "aria-label": "Sprint goal", placeholder: "Goal: what should be true when this sprint ends? (optional)", rows: "2" });
    goal.value = drafts.get("sprint-goal") ?? "";
    goal.oninput = () => drafts.set("sprint-goal", goal.value);
    const add = () => {
      if (name.value.trim() === "") return;
      drafts.delete("sprint-goal");
      vscode.postMessage({ type: "addSprint", name: name.value, goal: goal.value, ...(starts.value && { startsOn: starts.value }), ...(ends.value && { endsOn: ends.value }) });
    };
    name.onkeydown = (event) => event.key === "Enter" && add();
    return el("section", { class: "sform" }, [
      el("div", { class: "addtask" }, [field("sprint-name", "New sprint", name, "f1"), field("sprint-start", "Starts", starts), field("sprint-end", "Ends", ends), button("Plan sprint", "cta", add, "plus")]),
      goal,
    ]);
  }

  function renderActiveSprint(state, sprint, planned, memberIndex) {
    const tasks = state.tasks.filter((task) => task.sprintId === sprint.id);
    const done = tasks.filter((task) => task.status === "done").length;
    const left = daysLeft(sprint.endsOn);
    const timing = left === null ? "" : left < 1 ? ` · ended ${plural(1 - left, "day")} ago` : ` · ${plural(left, "day")} left`;
    const carry = el("select", { class: "in", id: "carry-to", "aria-label": "Where unfinished tasks go" }, [
      el("option", { value: "", text: "Unfinished tasks go back to the backlog" }),
      ...planned.map((next) => el("option", { value: next.id, text: `Unfinished tasks move to ${next.name}` })),
    ]);
    const close = () => vscode.postMessage({ type: "closeSprint", sprintId: sprint.id, ...(carry.value && { carryTo: carry.value }) });
    return el("section", { class: "sprint" }, [
      el("div", { class: "bar" }, [
        glyph("work"),
        el("div", { class: "grow" }, [el("h2", { class: "cl2", text: sprint.name }), el("div", { class: "sub", text: `Running · ${sprintDates(sprint)}${timing}` })]),
      ]),
      sprint.goal ? el("p", { class: "sgoal", text: sprint.goal }) : null,
      progressBar(done, tasks.length),
      el(
        "div",
        { class: "kan" },
        TASK_COLUMNS.map(([status, label, kind]) => {
          const column = tasks.filter((task) => task.status === status);
          return el("section", { class: "col column" }, [
            el("div", { class: "col-h" }, [glyph(kind), el("span", { text: label }), count(column.length)]),
            ...(column.length === 0 ? [empty("Nothing here.")] : column.map((task) => sprintTaskRow(task, memberIndex, status === "done" ? [] : [removeButton(task)]))),
          ]);
        }),
      ),
      el("div", { class: "row sclose" }, [carry, button("Close sprint", "cta", close, "check")]),
    ]);
  }

  function renderPlannedSprint(state, sprint, canStart, memberIndex) {
    const tasks = state.tasks.filter((task) => task.sprintId === sprint.id);
    return foldCard(`sprint-${sprint.id}`, true, { kind: "wait", headline: sprint.name, meta: [document.createTextNode(`Planned · ${sprintDates(sprint)} · ${plural(tasks.length, "task")}`)] }, [
      sprint.goal ? el("p", { class: "sgoal", text: sprint.goal }) : null,
      tasks.length === 0 ? empty("No tasks yet. Add some from the backlog.") : el("div", { class: "slist" }, tasks.map((task) => sprintTaskRow(task, memberIndex, [removeButton(task)]))),
      el("div", { class: "row" }, [
        canStart ? button("Start sprint", "cta", () => vscode.postMessage({ type: "startSprint", sprintId: sprint.id })) : el("span", { class: "muted", text: "Close the running sprint to start this one." }),
        button("Delete sprint", "sec", () => vscode.postMessage({ type: "deleteSprint", sprintId: sprint.id }), "close"),
      ]),
    ]);
  }

  function renderPastSprint(sprint, memberIndex) {
    const record = sprint.record ?? { done: [], unfinished: [], progress: [] };
    const total = record.done.length + record.unfinished.length;
    const section = (title, items, draw) =>
      items.length === 0 ? null : el("div", { class: "srec" }, [el("h3", { text: `${title} (${items.length})` }), el("div", { class: "slist" }, items.map(draw))]);
    return foldCard(
      `sprint-${sprint.id}`,
      false,
      {
        kind: "done",
        headline: sprint.name,
        meta: [document.createTextNode(`${sprintDates(sprint)} · ${record.done.length} of ${plural(total, "task")} done${sprint.closedAt ? ` · closed ${age(sprint.closedAt)} ago` : ""}`)],
      },
      [
        sprint.goal ? el("p", { class: "sgoal", text: sprint.goal }) : null,
        progressBar(record.done.length, total),
        section("Done", record.done, (task) => sprintTaskRow({ ...task, status: "done" }, memberIndex, [])),
        section("Not finished", record.unfinished, (task) => sprintTaskRow(task, memberIndex, [el("span", { class: "muted", text: STATUS_LABEL[task.status] ?? "" })])),
        section("Progress logged", record.progress, (entry) =>
          el("div", { class: "srow log" }, [
            el("span", { class: "grow" }, [el("b", { text: entry.author ?? "A teammate" }), document.createTextNode(` ${entry.summary}`), entry.task ? el("span", { class: "muted", text: ` · ${entry.task}` }) : null]),
            el("span", { class: "muted", text: age(entry.at) }),
          ]),
        ),
        total === 0 && record.progress.length === 0 ? empty("Nothing was recorded in this sprint.") : null,
      ],
    );
  }

  function renderSprints(state) {
    const sprints = state.sprints ?? [];
    const names = state.pulse.map((member) => member.name);
    const memberIndex = (name) => Math.max(0, names.indexOf(name));
    const active = sprints.find((sprint) => sprint.status === "active");
    const planned = sprints.filter((sprint) => sprint.status === "planned");
    const past = sprints.filter((sprint) => sprint.status === "closed");
    const open = [active, ...planned].filter(Boolean);
    const backlog = state.tasks.filter((task) => !task.sprintId && task.status !== "done");
    return el("div", { class: "bc-in" }, [
      el("div", { class: "bar" }, [
        el("div", {}, [
          el("h2", { text: "Sprints" }),
          el("div", { class: "sub", text: "Plan a sprint, add tasks from the backlog, start it, and close it when it ends. Closing keeps a record of what was done." }),
        ]),
      ]),
      renderSprintForm(),
      active ? renderActiveSprint(state, active, planned, memberIndex) : null,
      planned.length > 0 ? group("Planned", planned.length, planned.map((sprint) => renderPlannedSprint(state, sprint, !active, memberIndex))) : null,
      open.length > 0
        ? group("Backlog", backlog.length, [
            backlog.length === 0
              ? empty("Every open task is in a sprint.")
              : el("div", { class: "slist" }, backlog.map((task) => sprintTaskRow(task, memberIndex, [moveSelect(task, open)]))),
          ])
        : null,
      group("Past sprints", past.length, past.length === 0 ? [empty("No finished sprints yet. When you close one, what was done is kept here.")] : past.map((sprint) => renderPastSprint(sprint, memberIndex))),
    ]);
  }

  // ---- Page ----

  const TABS = [
    ["tasks", "Tasks", "board", renderTasks],
    ["sprints", "Sprints", "sprint", renderSprints],
    ["messages", "Messages", "inbox", renderMessages],
    ["team", "Team", "team", renderTeam],
    ["project", "Project", "board", renderProject],
    ["files", "Files", "board", renderFiles],
    ["activity", "Activity", "activity", renderActivity],
  ];

  function tabBadge(id, state) {
    if (id === "tasks") {
      const open = state.tasks.filter((task) => task.status !== "done").length;
      return open > 0 ? hex("", open) : null;
    }
    if (id === "messages") {
      const need = needCount(state) + state.assumptions.length;
      return need > 0 ? hex("needs", need) : null;
    }
    if (id === "project") {
      const open = (state.project?.items ?? []).filter((item) => item.status === "open" && item.kind === "bug").length;
      const mismatch = state.github?.check?.status === "mismatch" ? 1 : 0;
      return open + mismatch > 0 ? hex("needs", open + mismatch) : null;
    }
    if (id === "sprints") {
      const active = (state.sprints ?? []).find((sprint) => sprint.status === "active");
      const left = active ? state.tasks.filter((task) => task.sprintId === active.id && task.status !== "done").length : 0;
      return left > 0 ? hex("", left) : null;
    }
    if (id === "team") return liveChats(state) > 0 ? el("i", { class: "pd live" }) : null;
    return null;
  }

  function renderTop(state) {
    return el("header", { class: "top" }, [
      logo(),
      el("span", { class: "wm", text: "Hacky" }),
      el("span", { class: "sl", text: "/" }),
      el("span", { class: "tn", text: state.team.name }),
      el("div", { class: "inv" }, [
        document.createTextNode("Invite"),
        el("code", { text: state.team.invite_code }),
        el("button", {
          type: "button",
          class: "ib",
          "aria-label": "Copy invite code",
          title: "Copy invite code",
          onclick: () => navigator.clipboard.writeText(state.team.invite_code),
        }, [icon("copy")]),
      ]),
      el("span", { class: "sp" }),
      state.pulse.length > 0
        ? el("div", { class: "stack", role: "img", "aria-label": `Team presence: ${state.pulse.map((member) => `${member.name} ${member.chats > 0 ? "online" : "offline"}`).join(", ")}` }, state.pulse.slice(0, 6).map((member, index) => avatar(member, index)))
        : null,
      button("Open map", "sec", openMap, "map"),
    ]);
  }

  function renderBoard(state) {
    const current = TABS.find(([id]) => id === tab) ?? TABS[0];
    return el("div", { class: "board" }, [
      renderTop(state),
      el("nav", { class: "btabs", role: "tablist", "aria-label": "Board sections" }, TABS.map(([id, label, iconName]) =>
        el("button", {
          type: "button",
          role: "tab",
          class: `btab${tab === id ? " on selected" : ""}`,
          "aria-selected": String(tab === id),
          onclick: () => {
            tab = id;
            persist();
            render(lastState);
          },
        }, [icon(iconName), el("span", { class: "lbl", text: label }), tabBadge(id, state)]),
      )),
      el("main", { class: "bc", role: "tabpanel" }, [current[3](state)]),
    ]);
  }

  function renderMessage(text, kind) {
    return el("p", { class: kind, role: kind === "error" ? "alert" : "status", text });
  }

  function render(state) {
    const focusedDraft = document.activeElement?.tagName === "TEXTAREA" ? document.activeElement.id : null;
    const caret = focusedDraft ? document.activeElement.selectionStart : 0;
    const scrolled = window.scrollY;
    root.replaceChildren(
      ...[
        state.error ? renderMessage(state.error, "error") : null,
        state.notice ? renderMessage(state.notice, "notice") : null,
        state.user && state.team
          ? renderBoard(state)
          : el("p", { class: "empty", text: "Log in and choose a team in the Hacky sidebar to see the board." }),
      ].filter(Boolean),
    );
    pending = false;
    if (scrolled > 0) window.scrollTo(0, scrolled);
    if (focusedDraft) {
      const restored = document.getElementById(focusedDraft);
      if (restored) {
        restored.focus();
        restored.setSelectionRange(caret, caret);
      }
    }
    firstRender = false;
  }

  // A background refresh must not wipe out what the person is typing, so it waits until they leave the field.
  function isTyping() {
    const tagName = document.activeElement?.tagName;
    return tagName === "INPUT" || tagName === "TEXTAREA";
  }

  window.addEventListener("message", (event) => {
    lastState = event.data;
    const quiet = !lastState.error && !lastState.notice;
    if (isTyping() && quiet) {
      pending = true;
      return;
    }
    render(lastState);
  });

  document.addEventListener("focusout", () => {
    // Wait a tick: focus moves to the next field before it is known whether it is still a text field.
    setTimeout(() => {
      if (pending && lastState && !isTyping()) render(lastState);
    }, 0);
  });

  vscode.postMessage({ type: "ready" });
})();
