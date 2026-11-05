// Sidebar UI. Questions and progress come from teammates and agents, so they are untrusted:
// everything is rendered through textContent, never as HTML.
//
// Layout: header (team, quick actions, invite code), a status strip, three views (Needs you,
// Team, Tasks) and the folder connection on the bottom edge.
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");
  root.classList.add("hk");
  let lastState = null;

  // ---- Small helpers ----

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "onclick" || key === "onsubmit") node[key] = value;
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

  // 16px stroke icons, as path data.
  const ICONS = {
    board: ["M2 4.5A1.5 1.5 0 013.5 3h9A1.5 1.5 0 0114 4.5v7a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5z", "M6 3v10M10 3v10"],
    map: ["M5.2 4.8l5.6-.6M4.5 6.4l2.8 4.2M11.6 5.4L8.8 10.6", "M5.2 5a1.6 1.6 0 11-3.2 0 1.6 1.6 0 013.2 0zM14 4a1.6 1.6 0 11-3.2 0A1.6 1.6 0 0114 4zM9.6 12A1.6 1.6 0 116.4 12a1.6 1.6 0 013.2 0z"],
    fold: ["M4.5 6L8 3l3.5 3M4.5 10L8 13l3.5-3"],
    copy: ["M5.5 5.5h6a1.5 1.5 0 011.5 1.5v6a1.5 1.5 0 01-1.5 1.5h-6A1.5 1.5 0 014 13V7a1.5 1.5 0 011.5-1.5z", "M10.5 5.5V4A1.5 1.5 0 009 2.5H4A1.5 1.5 0 002.5 4v5A1.5 1.5 0 004 10.5h1.5"],
    inbox: ["M2.5 9.5l1.7-5.3h7.6l1.7 5.3v3h-11z", "M2.5 9.5h3.2l.8 1.5h3l.8-1.5h3.2"],
    team: ["M8.2 5.5a2.2 2.2 0 11-4.4 0 2.2 2.2 0 014.4 0z", "M2 13c.4-2.4 1.9-3.6 4-3.6s3.6 1.2 4 3.6", "M13.2 6a1.7 1.7 0 11-3.4 0 1.7 1.7 0 013.4 0z", "M11 9.6c1.9 0 2.8 1 3.2 2.9"],
    tasks: ["M2.5 4.5l1.3 1.3L6 3.5M2.5 10l1.3 1.3L6 9M8.5 5h5M8.5 10.5h5"],
    chevron: ["M4 6l4 4 4-4"],
    arrow: ["M3 8h10M9 4l4 4-4 4"],
    check: ["M3 8.5l3.2 3L13 4.5"],
    plus: ["M8 3v10M3 8h10"],
    close: ["M4 4l8 8M12 4l-8 8"],
    folder: ["M2 4.5h4l1.2 1.5H14v6.5H2z"],
    eye: ["M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z", "M10 8a2 2 0 11-4 0 2 2 0 014 0z"],
    gear: ["M8 10.3a2.3 2.3 0 100-4.6 2.3 2.3 0 000 4.6z", "M8 1.6l1 1.7 1.9-.4.6 1.9 1.8.9-.8 1.8.8 1.8-1.8.9-.6 1.9-1.9-.4-1 1.7-1-1.7-1.9.4-.6-1.9-1.8-.9.8-1.8-.8-1.8 1.8-.9.6-1.9 1.9.4z"],
    back: ["M13 8H3M7 4L3 8l4 4"],
    eyeOff: ["M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z", "M10 8a2 2 0 11-4 0 2 2 0 014 0z", "M3 13L13 3"],
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

  function age(iso) {
    const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
    if (Number.isNaN(minutes)) return "";
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m`;
    if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
    return `${Math.round(minutes / 1440)}d`;
  }

  const firstLetter = (name) => Array.from(name.trim())[0]?.toUpperCase() ?? "?";

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
  const hex = (kind, count, size = "") => el("span", { class: `hx ${kind} ${size}`.trim() }, [el("b", { text: String(count) })]);
  const count = (n) => el("span", { class: "cnt", text: String(n) });

  // ---- Remembered choices ----

  const saved = vscode.getState() ?? {};
  const folds = { ...(saved.folds ?? {}) };
  let view = ["needs", "team", "tasks"].includes(saved.view) ? saved.view : "needs";
  // A full-screen page over the views: null, "groups", "settings" (this group) or "profile".
  let page = null;
  const confirming = new Set(); // keys of two-step buttons that are waiting for their second click
  const persist = () => vscode.setState({ folds, view });

  const drafts = new Map(); // half-typed text, by field id
  const more = new Set(); // question ids whose context is shown in full
  const rejecting = new Set(); // assumption ids whose reject box is open
  const changing = new Set(); // decision ids whose change box is open
  const seen = new Set(); // ids already shown, so only new cards slide in
  let firstRender = true;
  let visibleFolds = []; // fold keys on screen, for Collapse all and Expand all

  const isOpen = (key, dflt) => (key in folds ? folds[key] : dflt);

  // A fold: a header button and a body that eases open. The choice is saved per key.
  function fold(key, defaultOpen, wrapClass, headClass, headChildren, bodyChildren) {
    visibleFolds.push({ key, dflt: defaultOpen });
    const open = isOpen(key, defaultOpen);
    const wrap = el("div", { class: `${wrapClass}${open ? " open" : ""}` });
    const head = el("button", { type: "button", class: headClass, "aria-expanded": String(open) }, [...headChildren, icon("chevron", "chev")]);
    const body = el("div", { class: `fold${open ? " open" : ""}` }, [el("div", { class: "fold-in" }, bodyChildren)]);
    head.onclick = () => {
      const next = !wrap.classList.contains("open");
      folds[key] = next;
      persist();
      wrap.classList.toggle("open", next);
      body.classList.toggle("open", next);
      head.setAttribute("aria-expanded", String(next));
      refreshFoldButton();
    };
    wrap.append(head, body);
    return wrap;
  }

  // A card whose headline is on its header: two lines folded, everything when open.
  function foldCard(key, defaultOpen, { kind, headline, meta, hot = false, fresh = false }, bodyChildren) {
    return fold(
      key,
      defaultOpen,
      `card${hot ? " hot" : ""}${fresh ? " fresh" : ""}`,
      "card-h",
      [glyph(kind), el("span", { class: "ch" }, [el("span", { class: "hl cl2", text: headline }), meta ? el("span", { class: "meta" }, meta) : null])],
      bodyChildren,
    );
  }

  // A boxed section with a title, an optional count and a one-line peek while it is folded.
  function foldSection(key, defaultOpen, title, total, peek, bodyChildren) {
    return fold(
      key,
      defaultOpen,
      "sec",
      "sec-h",
      [
        el("span", { class: "sec-t" }, [el("span", { text: title }), total === undefined ? null : count(total)]),
        peek ? el("span", { class: "sec-hl", text: peek }) : null,
      ],
      [el("div", { class: "sec-b" }, bodyChildren)],
    );
  }

  const group = (title, total, children) =>
    el("div", { class: "grp" }, [el("div", { class: "gh" }, [el("span", { text: title }), total === undefined ? null : count(total)]), ...children]);

  function iconButton(label, iconName, onclick, className = "") {
    return el("button", { type: "button", class: `ib ${className}`.trim(), "aria-label": label, title: label, onclick }, [icon(iconName)]);
  }

  // A text box that survives re-renders, which happen whenever anything changes for the team.
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

  // Marks an id as shown. True only the first time, and never on the very first render.
  function isNew(id) {
    const fresh = !firstRender && !seen.has(id);
    seen.add(id);
    return fresh;
  }

  // ---- Signed out and team choice ----

  // Log in and Sign up share one form. What was typed survives switching.
  let authMode = "login";
  const authValues = { email: "", password: "", confirm: "" };
  let authError = null; // a problem found in the form itself, before anything is sent

  function authField(name, label, type, autocomplete) {
    const input = el("input", { type, name, id: `auth-${name}`, class: "in", autocomplete, placeholder: label });
    input.value = authValues[name];
    input.oninput = () => {
      authValues[name] = input.value;
      if (authError) {
        authError = null;
        document.getElementById("auth-error")?.remove();
      }
    };
    return { input, field: el("div", { class: "field" }, [el("label", { class: "lab", for: `auth-${name}`, text: label }), input]) };
  }

  function renderSignedOut() {
    const signingUp = authMode === "signup";
    const email = authField("email", "Email", "email", "email");
    const password = authField("password", "Password", "password", signingUp ? "new-password" : "current-password");
    // Signing up asks for the password twice, so a typing slip can't lock the person out.
    const confirm = signingUp ? authField("confirm", "Repeat password", "password", "new-password") : null;
    const boxes = [password, confirm].filter(Boolean);
    for (const box of boxes) box.input.classList.add("pw-in");
    const toggle = el("button", { type: "button", class: "ib pw-toggle", "aria-label": "Show password", title: "Show password" }, [icon("eye")]);
    toggle.onclick = () => {
      const hidden = password.input.type === "password";
      for (const box of boxes) box.input.type = hidden ? "text" : "password";
      toggle.replaceChildren(icon(hidden ? "eyeOff" : "eye"));
      toggle.setAttribute("aria-label", hidden ? "Hide password" : "Show password");
      toggle.title = hidden ? "Hide password" : "Show password";
    };
    password.field.appendChild(toggle);

    const submit = () => {
      if (authValues.email.trim() === "" || authValues.password.trim() === "") return;
      if (signingUp && authValues.password !== authValues.confirm) {
        authError = authValues.confirm === "" ? "Repeat the password in the second box." : "The two passwords don't match.";
        if (lastState) render(lastState);
        return;
      }
      vscode.postMessage(
        signingUp
          ? { type: "signUp", email: authValues.email, password: authValues.password, confirmPassword: authValues.confirm }
          : { type: "signIn", email: authValues.email, password: authValues.password },
      );
    };
    const modeTab = (mode, label) =>
      el("button", {
        type: "button",
        role: "tab",
        class: `auth-tab${authMode === mode ? " on" : ""}`,
        "aria-selected": String(authMode === mode),
        text: label,
        onclick: () => {
          if (authMode === mode) return;
          authMode = mode;
          authError = null;
          if (lastState) render(lastState);
        },
      });

    return el("section", { class: "auth" }, [
      el("div", { class: "brand" }, [
        logo("logo big breathe"),
        el("h1", { text: "Hacky" }),
        el("p", { class: "muted", text: "One brain for every agent on your team." }),
      ]),
      el("div", { class: "auth-tabs", role: "tablist", "aria-label": "Log in or sign up" }, [modeTab("login", "Log in"), modeTab("signup", "Sign up")]),
      el("form", { class: "auth-form", onsubmit: (event) => (event.preventDefault(), submit()) }, [
        email.field,
        password.field,
        confirm ? confirm.field : null,
        authError ? el("p", { class: "error inline", id: "auth-error", role: "alert", text: authError }) : null,
        el("button", { type: "submit", class: "btn cta full" }, [document.createTextNode(signingUp ? "Create account" : "Log in to Hacky"), icon("arrow")]),
      ]),
    ]);
  }

  // A form of text fields and buttons. A button sends only when every field is filled.
  function form(fields, buttons) {
    const inputs = {};
    const rows = fields.map(({ name, label, mono = false, value = "" }) => {
      inputs[name] = el("input", { type: "text", class: `in${mono ? " mono-in" : ""}`, "aria-label": label, placeholder: label, name });
      inputs[name].value = value;
      return inputs[name];
    });
    const values = () => Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, input.value]));
    const row = buttons.map(({ label, className, send, icon: iconName }) =>
      el(
        "button",
        {
          type: "button",
          class: `btn ${className} full`,
          onclick: () => {
            const current = values();
            if (fields.every(({ name }) => current[name].trim() !== "")) vscode.postMessage(send(current));
          },
        },
        [iconName ? icon(iconName) : null, document.createTextNode(label)],
      ),
    );
    return el("form", { class: "form", onsubmit: (event) => event.preventDefault() }, [...rows, ...row]);
  }

  // Join with a code, or start a new group. Shared by the team choice and the groups page.
  function joinAndCreate(state) {
    const name = state.user?.displayName ?? "";
    return [
      el("div", { class: "opt" }, [
        el("h2", { text: "Join with an invite code" }),
        form(
          [
            { name: "code", label: "Invite code", mono: true },
            { name: "displayName", label: "Your name", value: name },
          ],
          [{ label: "Join team", className: "sec", send: (values) => ({ type: "joinTeam", ...values }) }],
        ),
      ]),
      el("div", { class: "or", text: "or" }),
      el("div", { class: "opt" }, [
        el("h2", { text: "Create a team" }),
        form(
          [
            { name: "name", label: "Team name" },
            { name: "displayName", label: "Your name", value: name },
          ],
          [{ label: "Create team", className: "sec", send: (values) => ({ type: "createTeam", ...values }) }],
        ),
      ]),
    ];
  }

  function renderTeamChoice(state) {
    return el("section", { class: "auth team-choice" }, [
      el("div", { class: "brand left" }, [
        logo(),
        el("div", {}, [el("h1", { text: "Pick your team" }), el("p", { class: "muted", text: "Agents share answers inside one team." })]),
      ]),
      state.teams.length > 0
        ? el("div", { class: "opt" }, [
            el("h2", { text: "Your teams" }),
            ...state.teams.map((team) =>
              el("button", {
                type: "button",
                class: "btn sec full",
                text: team.name,
                onclick: () => vscode.postMessage({ type: "selectTeam", teamId: team.id }),
              }),
            ),
          ])
        : null,
      ...joinAndCreate(state),
    ]);
  }

  // ---- What needs the person ----

  function renderQuestion(question) {
    const key = `q-${question.id}`;
    const answer = draftArea(`answer-${question.id}`, "Your answer", "Answer once. Every waiting agent gets it.");
    const long = (question.context ?? "").length > 140;
    const expanded = more.has(question.id);
    const ctx = question.context ? el("p", { class: `ctx${long && !expanded ? " cl3" : ""}`, text: question.context }) : null;
    const moreLink = long
      ? el("button", {
          type: "button",
          class: "lnk self",
          text: expanded ? "Show less" : "Show more",
          onclick: () => {
            if (more.has(question.id)) more.delete(question.id);
            else more.add(question.id);
            render(lastState);
          },
        })
      : null;
    return foldCard(
      key,
      true,
      {
        kind: "needs",
        headline: question.text,
        hot: true,
        fresh: isNew(key),
        meta: [
          question.routed_to_me ? el("span", { class: "badge" }, [el("i"), document.createTextNode("For you")]) : null,
          el("span", { class: "tr", text: question.asked_by_name }),
          el("span", { text: plural(question.waiting, "agent") + " waiting" }),
          el("span", { text: age(question.created_at) }),
        ],
      },
      [
        el("div", { class: "fb" }, [
          ctx,
          moreLink,
          answer,
          el("div", { class: "row" }, [
            el("span", { class: "hint", text: `Reaches ${plural(question.waiting, "agent")}` }),
            Object.assign(el("button", { type: "button", class: "btn pri", text: "Send answer" }), {
              onclick: () => sendDraft(answer, (text) => ({ type: "answer", questionId: question.id, text })),
            }),
          ]),
        ]),
      ],
    );
  }

  // A question between agents that is waiting for this person, for when none of their agents is running.
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
        meta: [
          el("span", { class: "badge" }, [el("i"), document.createTextNode("For you")]),
          el("span", { class: "tr", text: `${thread.other}'s agent asks` }),
          el("span", { text: age(thread.created_at) }),
        ],
      },
      [
        el("div", { class: "fb" }, [
          thread.context ? el("p", { class: "ctx", text: thread.context }) : null,
          answer,
          el("div", { class: "row" }, [
            el("span", { class: "hint", text: `Reaches ${thread.other}'s agent` }),
            Object.assign(el("button", { type: "button", class: "btn pri", text: "Send answer to agent" }), {
              onclick: () => sendDraft(answer, (text) => ({ type: "answerTeammate", questionId: thread.id, text })),
            }),
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
          el("span", { class: "meta" }, [el("span", { class: "tr", text: `Assumed by ${assumption.author}, for: ${assumption.question}` })]),
        ]),
      ]),
      el("div", { class: "as-a" }, [
        Object.assign(el("button", { type: "button", class: "btn sec" }, [icon("check"), document.createTextNode("Confirm")]), {
          onclick: () => vscode.postMessage({ type: "confirmAssumption", assumptionId: assumption.id }),
        }),
        Object.assign(el("button", { type: "button", class: "btn ghost", "aria-expanded": String(rejectOpen) }, [icon("close"), document.createTextNode("Reject…")]), {
          onclick: () => {
            if (rejecting.has(assumption.id)) rejecting.delete(assumption.id);
            else rejecting.add(assumption.id);
            render(lastState);
          },
        }),
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
              Object.assign(el("button", { type: "button", class: "btn pri", text: "Reject and notify" }), {
                onclick: () => sendDraft(reason, (text) => ({ type: "rejectAssumption", assumptionId: assumption.id, reason: text })),
              }),
            ]),
          ])
        : null,
    ]);
  }

  // Threads that need nothing from this person: answered ones, and ones this person's agent is waiting on.
  function renderQuiet(thread) {
    const open = thread.answer === null;
    const who = thread.direction === "incoming" ? `${thread.other}'s agent asked` : `Your agent asked ${thread.other}`;
    return el("div", { class: "dec" }, [
      el("div", { class: "dec-t cl2", text: thread.question }),
      thread.context ? el("div", { class: "dec-m", text: thread.context }) : null,
      el("div", { class: "dec-m", text: who }),
      open
        ? el("div", { class: "dec-m", text: `Waiting for ${thread.other}.` })
        : el("div", { class: "dec-a2" }, [
            el("div", { text: thread.answer }),
            el("div", { class: "dec-m", text: thread.answered_by_agent ? "Answered by their agent." : "Answered by a person." }),
          ]),
    ]);
  }

  // The same number as the activity bar badge and the status bar: what is addressed to this person.
  function needsCount(state) {
    return state.inbox.filter((question) => question.routed_to_me).length + state.agentChat.filter((thread) => thread.direction === "incoming" && thread.answer === null).length;
  }

  function renderNeeds(state) {
    const incoming = state.agentChat.filter((thread) => thread.direction === "incoming" && thread.answer === null);
    const quiet = state.agentChat.filter((thread) => !incoming.includes(thread));
    const need = state.inbox.length + incoming.length;
    const nodes = [];

    if (need === 0 && state.assumptions.length === 0) {
      nodes.push(
        el("div", { class: "empty" }, [
          svgEl("svg", { class: "breathe done-hex", width: "64", height: "72", viewBox: "0 0 24 27", "aria-hidden": "true" }, [
            svgEl("path", { d: "M12 1.5l9.5 5.5v11L12 23.5 2.5 18V7z", fill: "color-mix(in srgb,currentColor 14%,transparent)", stroke: "currentColor", "stroke-width": "1.2", "stroke-linejoin": "round" }),
            svgEl("path", { d: "M7.8 12.6l3 3 5.4-6", fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round" }),
          ]),
          el("h2", { text: "No open questions. All clear." }),
          el("p", {
            text: working(state) > 0 ? `${plural(working(state), "agent")} working. New questions show up here first.` : "New questions show up here first.",
          }),
          el("div", { class: "row center-row" }, [openBoardButton("sec"), openMapButton("ghost")]),
        ]),
      );
    } else {
      if (need > 0) nodes.push(group("For you", need, [...state.inbox.map(renderQuestion), ...incoming.map(renderIncomingThread)]));
      if (state.assumptions.length > 0) nodes.push(group("Agents are proceeding on", state.assumptions.length, state.assumptions.map(renderAssumption)));
    }

    if (quiet.length > 0) {
      const answered = quiet.filter((thread) => thread.answer !== null).length;
      nodes.push(
        foldSection("quiet", false, "Agent questions", quiet.length, `Read-only · ${answered} answered, ${quiet.length - answered} waiting`, quiet.map(renderQuiet)),
      );
    }
    return nodes;
  }

  // ---- Team ----

  const working = (state) => state.pulse.reduce((sum, member) => sum + member.chats, 0);

  // A small picture of the team: people as hexes, their live chats around them, open questions in orange.
  function miniMap(state) {
    const people = state.pulse.slice(0, 5);
    const links = [];
    const nodes = [];
    const labels = [];
    const step = people.length > 1 ? 220 / (people.length - 1) : 0;
    const centre = people.length > 1 ? 40 : 150;
    people.forEach((member, index) => {
      const x = centre + index * step;
      const y = [56, 32, 68][index % 3];
      const hexPoints = [[0, -21], [18.2, -10.5], [18.2, 10.5], [0, 21], [-18.2, 10.5], [-18.2, -10.5]].map(([dx, dy]) => `${x + dx},${y + dy}`).join(" ");
      nodes.push(svgEl("polygon", { class: "p", points: hexPoints }));
      labels.push(svgEl("text", { x: String(x), y: String(y + 5) }, [document.createTextNode(initials(member.name))]));
      const dots = Math.min(member.chats, 2);
      for (let dot = 0; dot < dots; dot += 1) {
        const dx = x + (dot === 0 ? -34 : 34);
        const dy = y + (index % 2 === 0 ? -34 : 34);
        links.push(svgEl("path", { d: `M${x} ${y}L${dx} ${dy}` }));
        nodes.push(svgEl("circle", { class: "n-work", cx: String(dx), cy: String(dy), r: "6" }));
      }
      if (index > 0) links.push(svgEl("path", { d: `M${centre + (index - 1) * step} ${[56, 32, 68][(index - 1) % 3]}L${x} ${y}` }));
    });
    const need = needsCount(state);
    if (need > 0 && people.length > 0) {
      links.push(svgEl("path", { class: "q", d: `M150 90L${centre} 56` }));
      nodes.push(svgEl("circle", { class: "n-q", cx: "150", cy: "88", r: "11" }));
      labels.push(svgEl("text", { class: "n-q-t", x: "150", y: "92" }, [document.createTextNode("?")]));
    }
    return svgEl(
      "svg",
      { class: "mini", viewBox: "0 0 300 104", role: "img", "aria-label": `Map preview: ${plural(state.pulse.length, "person").replace("persons", "people")}, ${plural(working(state), "chat")}, ${plural(need, "open question")}` },
      [svgEl("g", { class: "lk" }, links), ...nodes, ...labels],
    );
  }

  function renderPerson(member, index) {
    const key = `p-${member.name}`;
    const live = member.chats > 0;
    const headline = live ? `${plural(member.chats, "chat")} active` : member.updates > 0 ? `${plural(member.updates, "update")} in the last hour` : "No chat active";
    const rows = [
      ...member.focus.map((focus) =>
        el("li", { class: "chat" }, [glyph("work"), el("div", { class: "ch" }, [el("div", { class: "cn" }, [el("span", { class: "tr", text: "Now" })]), el("div", { class: "now cl2", text: focus })])]),
      ),
      member.updates > 0 && live ? el("li", { class: "chat" }, [glyph("idle"), el("div", { class: "ch" }, [el("div", { class: "now", text: `${plural(member.updates, "update")} in the last hour:` })])]) : null,
      ...member.latest.map((summary) => el("li", { class: "chat" }, [glyph("done"), el("div", { class: "ch" }, [el("div", { class: "now cl2", text: summary })])])),
    ];
    return fold(
      key,
      member.me,
      "person",
      "card-h center",
      [
        el("span", { class: `av a${(index % 4) + 1}` }, [document.createTextNode(initials(member.name)), el("i", { class: `pd ${live ? "live" : "idle"}` })]),
        el("span", { class: "ch" }, [
          el("span", { class: "hl tr", text: member.me ? `${member.name} (you)` : member.name }),
          el("span", { class: "meta tight" }, [el("span", { class: "tr", text: headline })]),
        ]),
      ],
      [el("ul", { class: "chats" }, rows.length > 0 ? rows : [el("li", { class: "now", text: "Nothing to show yet." })])],
    );
  }

  function renderDecision(decision) {
    const open = changing.has(decision.id);
    const replacement = open ? draftArea(`decision-${decision.id}`, "The new decision") : null;
    return el("div", { class: "dec" }, [
      el("div", { class: "dec-t", text: decision.text }),
      decision.question ? el("div", { class: "dec-m", text: decision.question }) : null,
      el("div", { class: "dec-m", text: `Decided by ${decision.author}.` }),
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
        el("button", {
          type: "button",
          class: "lnk",
          text: "Withdraw",
          onclick: () => vscode.postMessage({ type: "withdrawDecision", decisionId: decision.id }),
        }),
      ]),
      open ? el("p", { class: "hint", text: "Either one tells every agent on the team." }) : null,
      replacement,
      open
        ? Object.assign(el("button", { type: "button", class: "btn pri", text: "Replace" }), {
            onclick: () => sendDraft(replacement, (text) => ({ type: "changeDecision", decisionId: decision.id, text })),
          })
        : null,
    ]);
  }

  function renderTeamView(state) {
    return [
      el("div", { class: "mapcard" }, [
        miniMap(state),
        el("div", { class: "mc-row" }, [
          el("div", { class: "grow" }, [
            el("div", { class: "mc-t", text: "Hacky Map" }),
            el("div", { class: "mc-s tr", text: `${plural(state.pulse.length, "person").replace("persons", "people")} · ${plural(working(state), "chat")} · live` }),
          ]),
          openMapButton("pri"),
        ]),
      ]),
      group("People", state.pulse.length, state.pulse.length === 0 ? [el("p", { class: "muted", text: "Nobody is on the team yet." })] : state.pulse.map(renderPerson)),
      foldSection(
        "decisions",
        false,
        "Decisions",
        state.decisions.length,
        state.decisions.length > 0 ? `Latest: ${state.decisions[0].text}` : "No decisions yet.",
        state.decisions.length === 0 ? [el("p", { class: "muted", text: "No decisions yet." })] : state.decisions.map(renderDecision),
      ),
      foldSection(
        "feed",
        false,
        "Live feed",
        undefined,
        state.feed.length > 0 ? `${state.feed[0].author} ${state.feed[0].summary}` : "No activity yet.",
        state.feed.length === 0
          ? [el("p", { class: "muted", text: "No activity yet." })]
          : state.feed.map((item) =>
              el("div", { class: "fe" }, [
                glyph("work"),
                el("span", { class: "grow" }, [
                  el("b", { text: item.author }),
                  document.createTextNode(` ${item.summary}`),
                  item.files.length > 0 ? el("span", { class: "files tr", text: item.files.join(", ") }) : null,
                ]),
                el("span", { class: "age", text: age(item.created_at) }),
              ]),
            ),
      ),
    ];
  }

  // ---- Tasks ----

  const TASK_COLUMNS = [
    ["todo", "To do", "idle"],
    ["in_progress", "In progress", "work"],
    ["done", "Done", "done"],
  ];

  function renderTasksView(state) {
    return [
      form([{ name: "title", label: "New task" }], [{ label: "Add task", className: "add", icon: "plus", send: (values) => ({ type: "addTask", ...values }) }]),
      ...TASK_COLUMNS.map(([status, title, kind]) => {
        const tasks = state.tasks.filter((task) => task.status === status);
        const section = foldSection(
          `tasks-${status}`,
          status !== "done",
          title,
          tasks.length,
          tasks.length > 0 ? tasks[0].title : "Nothing here.",
          tasks.length === 0
            ? [el("p", { class: "muted", text: "Nothing here." })]
            : tasks.map((task) =>
                el("div", { class: "trow" }, [
                  glyph(kind),
                  el("div", { class: "ch" }, [
                    el("span", { class: "hl cl2 plain", text: task.title }),
                    task.owner || task.files.length > 0
                      ? el("span", { class: "tmeta" }, [
                          task.owner ? el("span", { text: task.owner }) : null,
                          task.files.length > 0 ? el("span", { class: "mono tr", text: task.files.join(", ") }) : null,
                        ])
                      : null,
                  ]),
                ]),
              ),
        );
        section.classList.add("task-column");
        return section;
      }),
    ];
  }

  // ---- Pages: groups, group settings and profile ----

  function setPage(next) {
    page = next;
    confirming.clear();
    if (lastState) render(lastState);
  }

  function pageFrame(title, children) {
    return el("section", { class: "page" }, [
      el("div", { class: "page-h" }, [iconButton("Back", "back", () => setPage(null)), el("h1", { class: "tr", text: title })]),
      ...children.filter(Boolean),
    ]);
  }

  // A labelled box that keeps what was typed across re-renders. Read it back with drafts.get(id).
  function draftInput(id, label, { type = "text", autocomplete = "off", fallback = "" } = {}) {
    const input = el("input", { type, id, class: "in", "aria-label": label, placeholder: label, autocomplete });
    input.value = drafts.get(id) ?? fallback;
    input.oninput = () => drafts.set(id, input.value);
    return el("div", { class: "field" }, [el("label", { class: "lab", for: id, text: label }), input]);
  }

  const draftValue = (id, fallback = "") => (drafts.get(id) ?? fallback).trim();

  // A button that needs a second click, so a destructive action can't happen by accident.
  function confirmButton(key, label, confirmLabel, className, onConfirm) {
    const armed = confirming.has(key);
    return el("button", {
      type: "button",
      class: className,
      text: armed ? confirmLabel : label,
      onclick: () => {
        if (!armed) {
          confirming.add(key);
          render(lastState);
          return;
        }
        confirming.delete(key);
        onConfirm();
      },
    });
  }

  const roleName = (role) => (role === "lead" ? "Lead" : "Member");

  function renderGroupsPage(state) {
    return pageFrame("Your groups", [
      state.teams.length === 0
        ? el("p", { class: "muted", text: "You aren't in any group yet. Join one with an invite code, or create your own." })
        : el(
            "div",
            { class: "glist" },
            state.teams.map((team) => {
              const current = state.team?.id === team.id;
              return el("div", { class: `gcard${current ? " cur" : ""}` }, [
                el("div", { class: "ch" }, [
                  el("span", { class: "hl tr plain", text: team.name }),
                  el("span", { class: "meta tight" }, [el("span", { class: "tr", text: `${plural(team.members, "member")} · ${roleName(team.role)}${current ? " · current" : ""}` })]),
                ]),
                current
                  ? el("button", { type: "button", class: "btn sec sm", text: "Settings", onclick: () => setPage("settings") })
                  : el("button", {
                      type: "button",
                      class: "btn sec sm",
                      text: "Open",
                      onclick: () => {
                        setPage(null);
                        vscode.postMessage({ type: "selectTeam", teamId: team.id });
                      },
                    }),
              ]);
            }),
          ),
      ...joinAndCreate(state),
    ]);
  }

  function renderMemberRow(member, index, canManage, teamId) {
    const actions =
      canManage && !member.me
        ? el("div", { class: "macts" }, [
            el("button", {
              type: "button",
              class: "lnk",
              text: member.role === "lead" ? "Make member" : "Make lead",
              onclick: () => vscode.postMessage({ type: "setRole", userId: member.id, role: member.role === "lead" ? "member" : "lead" }),
            }),
            confirmButton(`remove-${teamId}-${member.id}`, "Remove", "Sure?", "lnk danger", () => vscode.postMessage({ type: "removeMember", userId: member.id })),
          ])
        : null;
    return el("div", { class: "mrow" }, [
      el("span", { class: `av a${(index % 4) + 1}`, text: initials(member.name) }),
      el("div", { class: "ch" }, [
        el("span", { class: "hl tr plain", text: member.me ? `${member.name} (you)` : member.name }),
        el("span", { class: "meta tight" }, [el("span", { class: `role ${member.role}`, text: roleName(member.role) })]),
      ]),
      actions,
    ]);
  }

  function renderSettingsPage(state) {
    const team = state.team;
    const lead = team.role === "lead";
    const nameId = `rename-${team.id}`;
    const deleteId = `delete-${team.id}`;
    const rename = () => {
      const name = draftValue(nameId, team.name);
      if (name === "" || name === team.name) return;
      drafts.delete(nameId);
      vscode.postMessage({ type: "renameTeam", name });
    };
    const deleteInput = lead ? draftInput(deleteId, `Type "${team.name}" to delete this group`) : null;
    const deleteButton = lead ? el("button", { type: "button", class: "btn danger", text: "Delete group" }) : null;
    if (deleteButton) {
      const matches = () => draftValue(deleteId) === team.name;
      deleteButton.disabled = !matches();
      deleteInput.querySelector("input").addEventListener("input", () => (deleteButton.disabled = !matches()));
      deleteButton.onclick = () => {
        if (!matches()) return;
        drafts.delete(deleteId);
        setPage(null);
        vscode.postMessage({ type: "deleteTeam" });
      };
    }
    return pageFrame("Group settings", [
      lead ? null : el("p", { class: "hint", text: "You're a member. Only a lead can rename the group, manage people or delete it." }),
      el("div", { class: "opt" }, [
        el("h2", { text: "Name" }),
        lead
          ? el("form", { class: "form", onsubmit: (event) => (event.preventDefault(), rename()) }, [
              draftInput(nameId, "Group name", { fallback: team.name }),
              el("button", { type: "submit", class: "btn pri full", text: "Save name" }),
            ])
          : el("p", { text: team.name }),
      ]),
      el("div", { class: "opt" }, [
        el("h2", { text: "Invite people" }),
        el("p", { class: "hint", text: "Share this code. Anyone who has it can join the group as a member." }),
        el("div", { class: "inv" }, [
          el("code", { class: "inv-c", text: team.invite_code }),
          iconButton("Copy invite code", "copy", () => navigator.clipboard.writeText(team.invite_code), "sm"),
        ]),
        lead ? confirmButton(`invite-${team.id}`, "Make a new code", "Replace it? The old code stops working", "btn sec", () => vscode.postMessage({ type: "regenerateInvite" })) : null,
      ]),
      el("div", { class: "opt" }, [
        el("h2", { text: `Members (${state.members.length})` }),
        el("div", { class: "mlist" }, state.members.map((member, index) => renderMemberRow(member, index, lead, team.id))),
      ]),
      el("div", { class: "opt danger-zone" }, [
        el("h2", { text: "Leave or delete" }),
        confirmButton(`leave-${team.id}`, "Leave group", "Leave for good?", "btn ghost", () => {
          setPage(null);
          vscode.postMessage({ type: "leaveTeam" });
        }),
        lead ? el("p", { class: "hint", text: "If you are the only lead, make someone else a lead before you leave." }) : null,
        lead ? deleteInput : null,
        lead ? el("p", { class: "hint", text: "Deleting removes the group, its tasks, decisions and history for everyone. It can't be undone." }) : null,
        deleteButton,
      ]),
    ]);
  }

  function renderProfilePage(state) {
    const name = state.user.displayName;
    const saveName = () => {
      const value = draftValue("profile-name", name ?? "");
      if (value === "" || value === name) return;
      drafts.delete("profile-name");
      vscode.postMessage({ type: "updateProfile", displayName: value });
    };
    const savePassword = () => {
      const password = drafts.get("profile-password") ?? "";
      const confirm = drafts.get("profile-confirm") ?? "";
      if (password === "") return;
      vscode.postMessage({ type: "changePassword", password, confirmPassword: confirm });
    };
    return pageFrame("Profile", [
      el("div", { class: "opt" }, [
        el("div", { class: "prow" }, [
          el("span", { class: "av a1 big", text: initials(name ?? state.user.email) }),
          el("div", { class: "ch" }, [el("span", { class: "hl tr plain", text: name ?? state.user.email }), el("span", { class: "meta tight" }, [el("span", { class: "tr", text: state.user.email })])]),
        ]),
        el("form", { class: "form", onsubmit: (event) => (event.preventDefault(), saveName()) }, [
          draftInput("profile-name", "Username", { fallback: name ?? "" }),
          el("p", { class: "hint", text: "Teammates see this name in all your groups." }),
          el("button", { type: "submit", class: "btn pri full", text: "Save username" }),
        ]),
      ]),
      el("div", { class: "opt" }, [
        el("h2", { text: "Change password" }),
        el("form", { class: "form", onsubmit: (event) => (event.preventDefault(), savePassword()) }, [
          draftInput("profile-password", "New password", { type: "password", autocomplete: "new-password" }),
          draftInput("profile-confirm", "Repeat new password", { type: "password", autocomplete: "new-password" }),
          el("button", { type: "submit", class: "btn sec full", text: "Change password" }),
        ]),
      ]),
      el("div", { class: "opt" }, [
        el("h2", { text: "Groups" }),
        el("p", { class: "hint", text: `You are in ${plural(state.teams.length, "group")}.` }),
        el("button", { type: "button", class: "btn sec full", text: "See your groups", onclick: () => setPage("groups") }),
      ]),
      el("button", { type: "button", class: "btn ghost full", text: "Log out", onclick: () => vscode.postMessage({ type: "signOut" }) }),
    ]);
  }

  function renderPage(state) {
    const content = page === "groups" ? renderGroupsPage(state) : page === "settings" ? renderSettingsPage(state) : renderProfilePage(state);
    return el("div", { class: "scroll" }, [content]);
  }

  // ---- Frame: header, status strip, tabs, folder connection ----

  function openBoardButton(className = "sec") {
    return Object.assign(el("button", { type: "button", class: `btn ${className}`, text: "Open board" }), { onclick: () => vscode.postMessage({ type: "openBoard" }) });
  }

  function openMapButton(className = "sec") {
    return Object.assign(el("button", { type: "button", class: `btn ${className}`, text: "Open map" }), { onclick: () => vscode.postMessage({ type: "openMap" }) });
  }

  let foldButton = null;
  function refreshFoldButton() {
    if (!foldButton) return;
    const anyOpen = visibleFolds.some(({ key, dflt }) => isOpen(key, dflt));
    const label = anyOpen ? "Collapse all" : "Expand all";
    foldButton.setAttribute("aria-label", label);
    foldButton.title = label;
  }

  function collapseOrExpandAll() {
    const anyOpen = visibleFolds.some(({ key, dflt }) => isOpen(key, dflt));
    for (const { key } of visibleFolds) folds[key] = !anyOpen;
    persist();
    render(lastState);
  }

  function renderHeader(state) {
    foldButton = iconButton("Collapse all", "fold", collapseOrExpandAll);
    const members = state.pulse.length;
    return el("header", { class: "hd" }, [
      el("div", { class: "hd-row" }, [
        logo(),
        el("div", { class: "team" }, [
          el("div", { class: "team-n tr", text: state.team.name }),
          members > 0 ? el("div", { class: "team-s tr", text: plural(members, "member") }) : null,
        ]),
        iconButton("Your groups", "team", () => setPage("groups")),
        el("div", { class: "acts" }, [
          iconButton("Open board", "board", () => vscode.postMessage({ type: "openBoard" })),
          Object.assign(iconButton("Open map", "map", () => vscode.postMessage({ type: "openMap" })), {}),
          foldButton,
          iconButton("Group settings", "gear", () => setPage("settings")),
        ]),
      ]),
      el("div", { class: "inv" }, [
        el("span", { class: "inv-l", text: "Invite code" }),
        el("code", { class: "inv-c", text: state.team.invite_code }),
        iconButton("Copy invite code", "copy", () => navigator.clipboard.writeText(state.team.invite_code), "sm"),
      ]),
    ]);
  }

  function tile(kind, total, label, hot, target) {
    return el("button", { type: "button", class: `tile${hot ? " hot" : ""}`, onclick: () => setView(target) }, [hex(kind, total), el("span", { class: "t1", text: label })]);
  }

  function renderStrip(state) {
    const need = needsCount(state);
    const waiting = state.inbox.reduce((sum, question) => sum + question.waiting, 0);
    return el("div", { class: "strip" }, [
      tile(need > 0 ? "needs" : "", need, "need you", need > 0, "needs"),
      tile("work", working(state), "working", false, "team"),
      tile(waiting > 0 ? "wait" : "", waiting, "waiting", false, "needs"),
    ]);
  }

  function renderTabs(state) {
    const need = needsCount(state);
    const open = state.tasks.filter((task) => task.status !== "done").length;
    const tab = (id, label, iconName, badge) =>
      el(
        "button",
        { type: "button", class: `tab${view === id ? " on" : ""}`, "aria-pressed": String(view === id), onclick: () => setView(id) },
        [icon(iconName), el("span", { class: "lbl", text: label }), badge],
      );
    return el("nav", { class: "tabs", "aria-label": "Hacky views" }, [
      tab("needs", "Needs you", "inbox", hex(need > 0 ? "needs" : "", need, "sm")),
      tab("team", "Team", "team", working(state) > 0 ? el("i", { class: "pd live" }) : null),
      tab("tasks", "Tasks", "tasks", hex("", open, "sm")),
    ]);
  }

  function setView(next) {
    if (view === next) return;
    view = next;
    persist();
    render(lastState);
  }

  const WORKSPACE_TEXT = {
    none: "Open a folder to connect it to this team.",
    not_connected: "This folder isn't connected yet.",
    connected: "This folder is connected.",
    outdated: "This folder is connected, but the Hacky instructions in its CLAUDE.md are from an older version.",
    other_team: "This folder is connected to a different team.",
  };

  // Always the bottom edge: a quiet line once connected, a clear call to action until then.
  function renderWorkspace(state) {
    const outdated = state.workspace === "outdated";
    const canConnect = state.workspace === "not_connected" || state.workspace === "other_team" || outdated;
    const connect = () => vscode.postMessage({ type: "connectWorkspace" });
    if (state.workspace === "connected") {
      return el("div", { class: "foot" }, [glyph("done"), el("span", { class: "ft tr", text: WORKSPACE_TEXT.connected })]);
    }
    return el("div", { class: "foot off" }, [
      el("div", { class: "row2" }, [glyph(canConnect ? "wait" : "idle"), el("p", { text: WORKSPACE_TEXT[state.workspace] })]),
      canConnect
        ? el("p", {
            class: "hint",
            text: outdated
              ? "Updating replaces only the block between the hacky:start and hacky:end markers in CLAUDE.md. Start a new Claude Code chat afterwards."
              : "This writes .mcp.json and a block in CLAUDE.md, and allows the Hacky tools in .claude/settings.local.json.",
          })
        : null,
      canConnect
        ? Object.assign(el("button", { type: "button", class: "btn pri full" }, [icon("folder"), document.createTextNode(outdated ? "Update setup" : "Connect this folder")]), { onclick: connect })
        : null,
    ]);
  }

  function renderAccount(state) {
    return el("footer", { class: "account" }, [
      el("button", { type: "button", class: "who", title: "Your profile", "aria-label": "Your profile", onclick: () => setPage("profile") }, [
        el("span", { class: "av a1 sm", text: firstLetter(state.user.displayName ?? state.user.email) }),
        el("span", { class: "tr", text: state.user.displayName ?? state.user.email }),
      ]),
      el("button", { type: "button", class: "lnk", text: "Log out", onclick: () => vscode.postMessage({ type: "signOut" }) }),
    ]);
  }

  function renderTeam(state) {
    visibleFolds = [];
    const content = view === "needs" ? renderNeeds(state) : view === "team" ? renderTeamView(state) : renderTasksView(state);
    const frame = [renderHeader(state), renderStrip(state), renderTabs(state), el("div", { class: "scroll" }, content.filter(Boolean)), renderWorkspace(state)];
    refreshFoldButton();
    return frame;
  }

  // A background refresh must not wipe out what the user is typing, so plain re-renders
  // leave form fields alone while one of them has focus.
  function isEditing() {
    const active = document.activeElement;
    return active && active.tagName === "INPUT";
  }

  function render(state) {
    const focused = document.activeElement;
    const focusedDraft = focused?.tagName === "TEXTAREA" ? focused.id : null;
    const caret = focusedDraft ? focused.selectionStart : 0;
    const scrolled = root.querySelector(".scroll")?.scrollTop ?? 0;
    visibleFolds = [];
    if (!state.user) page = null;
    // Settings belong to a group, so without one there is nothing to show.
    const showPage = Boolean(state.user && page && !(page === "settings" && !state.team));
    root.replaceChildren(
      ...[
        state.error ? el("p", { class: "error", role: "alert", text: state.error }) : null,
        state.notice ? el("p", { class: "notice", role: "status", text: state.notice }) : null,
        ...(!state.user ? [renderSignedOut()] : showPage ? [renderPage(state)] : state.team ? renderTeam(state) : [renderTeamChoice(state)]),
        state.user ? renderAccount(state) : null,
      ].filter(Boolean),
    );
    const scroller = root.querySelector(".scroll");
    if (scroller) scroller.scrollTop = scrolled;
    if (focusedDraft) {
      const restored = document.getElementById(focusedDraft);
      if (restored) {
        restored.focus();
        restored.setSelectionRange(caret, caret);
      }
    }
    firstRender = false;
  }

  window.addEventListener("message", (event) => {
    const previous = lastState;
    lastState = event.data;
    if (lastState.notice === "Password changed.") {
      drafts.delete("profile-password");
      drafts.delete("profile-confirm");
    }
    // Leaving or deleting the open group closes its settings.
    if (page === "settings" && !lastState.team) page = null;
    const sameScreen = previous && !previous.user === !lastState.user && !previous.team === !lastState.team;
    const quiet = !lastState.error && !lastState.notice;
    if (isEditing() && sameScreen && quiet) return;
    render(lastState);
  });

  vscode.postMessage({ type: "ready" });
})();
