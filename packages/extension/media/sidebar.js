// Sidebar UI. Questions and progress come from teammates and agents, so they are untrusted:
// everything is rendered through textContent, never as HTML.
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");
  let lastState = null;

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

  function form(fields, buttons) {
    const inputs = {};
    const rows = fields.map(({ name, label, type = "text", value = "" }) => {
      inputs[name] = el("input", { type, "aria-label": label, placeholder: label, name });
      inputs[name].value = value;
      return inputs[name];
    });
    const values = () => Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, input.value]));
    const buttonRow = el(
      "div",
      { class: "row" },
      buttons.map(({ label, secondary, send }) =>
        el("button", {
          type: "button",
          text: label,
          class: secondary ? "secondary" : "",
          onclick: () => {
            const current = values();
            if (fields.every(({ name }) => current[name].trim() !== "")) vscode.postMessage(send(current));
          },
        }),
      ),
    );
    return el("form", { onsubmit: (event) => event.preventDefault() }, [...rows, buttonRow]);
  }

  // Which sections and cards are folded survives re-renders and reloads of the panel.
  const folds = { ...(vscode.getState()?.folds ?? {}) };

  // A <details> the person can fold. Without a saved choice it starts as defaultOpen.
  function fold(key, defaultOpen, className, summaryChildren, bodyChildren) {
    const node = el("details", { class: className }, [
      el("summary", {}, summaryChildren),
      el("div", { class: "fold-body" }, bodyChildren),
    ]);
    node.open = key in folds ? folds[key] : defaultOpen;
    node.ontoggle = () => {
      if (folds[key] === node.open) return;
      folds[key] = node.open;
      vscode.setState({ folds });
    };
    return node;
  }

  // With a key the section can be folded; without one (log in, team choice) it is always open.
  // The count, when given, is a badge on the right of the title.
  function section(title, children, key, defaultOpen = true, count) {
    if (!key) return el("section", {}, [el("h2", { text: title }), ...children]);
    const heading = [
      el("span", { class: "section-title", text: title }),
      count === undefined ? null : el("span", { class: `count${count > 0 ? " active" : ""}`, text: String(count) }),
    ].filter(Boolean);
    return el("section", { class: "panel" }, [fold(`section-${key}`, defaultOpen, "section-fold", heading, children)]);
  }

  // A card with its headline on the summary line: one truncated line when folded, the full text when open.
  // A list entry (task, update, person) that is one truncated line until the person opens it.
  function foldItem(key, headline, bodyChildren) {
    return el("article", { class: "feed-item" }, [
      fold(`item-${key}`, false, "item-fold", [el("span", { class: "card-title plain", text: headline })], bodyChildren),
    ]);
  }

  function foldCard(key, defaultOpen, headline, badge, bodyChildren) {
    return el("article", { class: "card" }, [
      fold(`card-${key}`, defaultOpen, "card-fold", [badge, el("span", { class: "card-title", text: headline })].filter(Boolean), bodyChildren),
    ]);
  }


  // Log in and Sign up share one card: two tabs, one form. What was typed survives switching tabs.
  let authMode = "login";
  const authValues = { email: "", password: "" };

  function brandMark() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    for (const [name, value] of Object.entries({ viewBox: "0 0 24 24", width: "28", height: "28", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "aria-hidden": "true" })) {
      svg.setAttribute(name, value);
    }
    for (const d of ["M6 4v16", "M18 4v16", "M6 12h12"]) {
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    return el("div", { class: "brand-mark" }, [svg]);
  }

  function authField(name, label, type, autocomplete) {
    const input = el("input", { type, name, id: `auth-${name}`, autocomplete, placeholder: label });
    input.value = authValues[name];
    input.oninput = () => (authValues[name] = input.value);
    return { input, field: el("div", { class: "field" }, [el("label", { for: `auth-${name}`, text: label }), input]) };
  }

  function renderSignedOut() {
    const signingUp = authMode === "signup";
    const email = authField("email", "Email", "email", "email");
    const password = authField("password", "Password", "password", signingUp ? "new-password" : "current-password");
    const toggle = el("button", {
      type: "button",
      class: "link",
      text: "Show",
      "aria-label": "Show password",
      onclick: () => {
        const hidden = password.input.type === "password";
        password.input.type = hidden ? "text" : "password";
        toggle.textContent = hidden ? "Hide" : "Show";
        toggle.setAttribute("aria-label", hidden ? "Hide password" : "Show password");
      },
    });
    password.field.appendChild(toggle);

    const submit = () => {
      if (authValues.email.trim() === "" || authValues.password.trim() === "") return;
      vscode.postMessage({ type: signingUp ? "signUp" : "signIn", email: authValues.email, password: authValues.password });
    };
    const tab = (mode, label) =>
      el("button", {
        type: "button",
        role: "tab",
        class: `tab${authMode === mode ? " selected" : ""}`,
        "aria-selected": String(authMode === mode),
        text: label,
        onclick: () => {
          if (authMode === mode) return;
          authMode = mode;
          if (lastState) render(lastState);
        },
      });

    return el("section", { class: "auth" }, [
      el("div", { class: "brand" }, [
        brandMark(),
        el("h1", { text: "Hacky" }),
        el("p", { class: "muted", text: "One shared memory, task board and question queue for your team's agents." }),
      ]),
      el("div", { class: "tabs", role: "tablist" }, [tab("login", "Log in"), tab("signup", "Sign up")]),
      el("form", { class: "auth-form", onsubmit: (event) => (event.preventDefault(), submit()) }, [
        email.field,
        password.field,
        el("button", { type: "submit", class: "wide primary", text: signingUp ? "Create account" : "Log in to Hacky" }),
      ]),
      el("p", {
        class: "muted auth-hint",
        text: signingUp ? "Already have an account? Pick Log in above." : "New here? Pick Sign up above to create an account.",
      }),
    ]);
  }

  function renderTeamChoice(state) {
    return el("div", {}, [
      state.teams.length > 0
        ? section(
            "Your teams",
            state.teams.map((team) =>
              el("button", {
                type: "button",
                class: "secondary wide",
                text: team.name,
                onclick: () => vscode.postMessage({ type: "selectTeam", teamId: team.id }),
              }),
            ),
          )
        : null,
      section("Create a team", [
        form(
          [
            { name: "name", label: "Team name" },
            { name: "displayName", label: "Your name" },
          ],
          [{ label: "Create team", send: (values) => ({ type: "createTeam", ...values }) }],
        ),
      ]),
      section("Join a team", [
        form(
          [
            { name: "code", label: "Invite code" },
            { name: "displayName", label: "Your name" },
          ],
          [{ label: "Join team", send: (values) => ({ type: "joinTeam", ...values }) }],
        ),
      ]),
    ]);
  }

  const WORKSPACE_TEXT = {
    none: "Open a folder to connect it to this team.",
    not_connected: "This folder isn't connected yet.",
    connected: "This folder is connected.",
    outdated: "This folder is connected, but the Hacky instructions in its CLAUDE.md are from an older version.",
    other_team: "This folder is connected to a different team.",
  };

  function renderWorkspace(state) {
    const outdated = state.workspace === "outdated";
    const canConnect = state.workspace === "not_connected" || state.workspace === "other_team" || outdated;
    return section("Workspace", [
      el("p", { text: WORKSPACE_TEXT[state.workspace] }),
      canConnect
        ? el("p", {
            class: "muted",
            text: outdated
              ? "Updating replaces only the block between the hacky:start and hacky:end markers in CLAUDE.md. Start a new Claude Code chat afterwards."
              : "This writes .mcp.json and a block in CLAUDE.md, and allows the Hacky tools in .claude/settings.local.json.",
          })
        : null,
      canConnect
        ? el("button", {
            type: "button",
            class: "wide",
            text: outdated ? "Update setup" : "Connect this folder",
            onclick: () => vscode.postMessage({ type: "connectWorkspace" }),
          })
        : null,
    ], "workspace", state.workspace !== "connected");
  }

  // A text box that survives re-renders, which happen whenever anything changes for the team.
  function draftArea(id, label) {
    const area = el("textarea", { "aria-label": label, placeholder: label, rows: "2", id });
    area.value = drafts.get(id) ?? "";
    area.oninput = () => drafts.set(id, area.value);
    return area;
  }

  function sendDraft(area, buildMessage) {
    if (area.value.trim() === "") return;
    drafts.delete(area.id);
    vscode.postMessage(buildMessage(area.value));
  }

  function renderQuestion(question) {
    const waiting = question.waiting === 1 ? "1 agent waiting" : `${question.waiting} agents waiting`;
    const answer = draftArea(`answer-${question.id}`, "Your answer");
    return foldCard(
      `q-${question.id}`,
      true,
      question.text,
      question.routed_to_me ? el("span", { class: "badge", text: "For you" }) : null,
      [
        question.context ? el("p", { class: "muted", text: question.context }) : null,
        el("p", { class: "muted", text: `From ${question.asked_by_name}. ${waiting}.` }),
        answer,
        el("button", {
          type: "button",
          class: "wide",
          text: "Send answer",
          onclick: () => sendDraft(answer, (text) => ({ type: "answer", questionId: question.id, text })),
        }),
      ],
    );
  }

  function renderInbox(state) {
    return section("Inbox", [
      state.inbox.length === 0 ? el("p", { class: "muted", text: "No open questions." }) : null,
      ...state.inbox.map(renderQuestion),
    ], "inbox", state.inbox.length > 0, state.inbox.length);
  }

  // Questions between agents. Open ones sent to this person can be answered here, for when
  // none of their agents is running.
  function renderThread(thread) {
    const incoming = thread.direction === "incoming";
    const open = thread.answer === null;
    const who = incoming ? `${thread.other}'s agent asks` : `Your agent asked ${thread.other}`;
    const answer = incoming && open ? draftArea(`peer-${thread.id}`, "Your answer") : null;
    // Only a question waiting for this person starts open; finished conversations start folded.
    return foldCard(`t-${thread.id}`, incoming && open, thread.question, null, [
      el("p", { class: "muted", text: who }),
      thread.context ? el("p", { class: "muted", text: thread.context }) : null,
      !open
        ? el("p", { text: thread.answer })
        : !incoming
          ? el("p", { class: "muted", text: `Waiting for ${thread.other}.` })
          : null,
      !open ? el("p", { class: "muted", text: thread.answered_by_agent ? "Answered by their agent." : "Answered by a person." }) : null,
      answer,
      answer
        ? el("button", {
            type: "button",
            class: "wide",
            text: "Send answer to agent",
            onclick: () => sendDraft(answer, (text) => ({ type: "answerTeammate", questionId: thread.id, text })),
          })
        : null,
    ]);
  }

  function renderAgentChat(state) {
    const waiting = state.agentChat.filter((thread) => thread.direction === "incoming" && thread.answer === null).length;
    return section("Agent questions", [
      state.agentChat.length === 0 ? el("p", { class: "muted", text: "No agent has asked another agent anything yet." }) : null,
      ...state.agentChat.map(renderThread),
    ], "agent", waiting > 0, waiting);
  }

  function renderPulseMember(member) {
    const chats = member.chats === 1 ? "1 chat active" : `${member.chats} chats active`;
    return foldItem(`p-${member.name}`, `${member.me ? `${member.name} (you)` : member.name} · ${member.chats > 0 ? chats : "No chat active"}`, [
      ...member.focus.map((focus) => el("p", { class: "muted", text: `Now: ${focus}` })),
      member.updates > 0
        ? el("p", { class: "muted", text: `${member.updates === 1 ? "1 update" : `${member.updates} updates`} in the last hour:` })
        : null,
      ...member.latest.map((summary) => el("p", { text: summary })),
    ]);
  }

  function renderPulse(state) {
    return section("Team pulse", [
      state.pulse.length === 0 ? el("p", { class: "muted", text: "Nobody is on the team yet." }) : null,
      ...state.pulse.map(renderPulseMember),
    ], "pulse");
  }

  function renderAssumption(assumption) {
    const reason = draftArea(`reason-${assumption.id}`, "Why it's wrong, or what to do instead");
    return foldCard(`a-${assumption.id}`, true, assumption.text, null, [
      el("p", { class: "muted", text: `Assumed by ${assumption.author}, for: ${assumption.question}` }),
      el("button", {
        type: "button",
        text: "Confirm",
        onclick: () => vscode.postMessage({ type: "confirmAssumption", assumptionId: assumption.id }),
      }),
      reason,
      el("button", {
        type: "button",
        class: "secondary",
        text: "Reject",
        onclick: () => sendDraft(reason, (text) => ({ type: "rejectAssumption", assumptionId: assumption.id, reason: text })),
      }),
    ]);
  }

  function renderAssumptions(state) {
    return section("Assumptions", [
      state.assumptions.length === 0 ? el("p", { class: "muted", text: "No agent is working on an assumption." }) : null,
      ...state.assumptions.map(renderAssumption),
    ], "assumptions", state.assumptions.length > 0, state.assumptions.length);
  }

  function renderDecision(decision) {
    const replacement = draftArea(`decision-${decision.id}`, "The new decision");
    const actions = el("details", { class: "actions" }, [
      el("summary", { text: "Change or withdraw" }),
      el("p", { class: "muted", text: "Either one tells every agent on the team." }),
      replacement,
      el("button", {
        type: "button",
        text: "Replace",
        onclick: () => sendDraft(replacement, (text) => ({ type: "changeDecision", decisionId: decision.id, text })),
      }),
      el("button", {
        type: "button",
        class: "secondary",
        text: "Withdraw",
        onclick: () => vscode.postMessage({ type: "withdrawDecision", decisionId: decision.id }),
      }),
    ]);
    actions.open = openDecisions.has(decision.id);
    actions.ontoggle = () => (actions.open ? openDecisions.add(decision.id) : openDecisions.delete(decision.id));
    // Decisions are settled, so they start folded.
    return foldCard(`d-${decision.id}`, false, decision.text, null, [
      decision.question ? el("p", { class: "muted", text: decision.question }) : null,
      el("p", { class: "muted", text: `Decided by ${decision.author}.` }),
      actions,
    ]);
  }

  function renderDecisions(state) {
    return section("Decisions", [
      state.decisions.length === 0 ? el("p", { class: "muted", text: "No decisions yet." }) : null,
      ...state.decisions.map(renderDecision),
    ], "decisions", false, state.decisions.length);
  }

  const TASK_COLUMNS = [
    ["todo", "To do"],
    ["in_progress", "In progress"],
    ["done", "Done"],
  ];

  function renderTasks(state) {
    return section("Task board", [
      ...TASK_COLUMNS.map(([status, title]) => {
        const tasks = state.tasks.filter((task) => task.status === status);
        return el("div", { class: "task-column" }, [
          el("h3", { text: `${title} (${tasks.length})` }),
          ...tasks.map((task) =>
            foldItem(`task-${task.id ?? task.title}`, task.title, [
              task.owner || task.files.length > 0
                ? el("p", { class: "muted", text: [task.owner, task.files.join(", ")].filter(Boolean).join(" · ") })
                : null,
            ]),
          ),
        ]);
      }),
      form([{ name: "title", label: "New task" }], [{ label: "Add task", secondary: true, send: (values) => ({ type: "addTask", ...values }) }]),
    ], "tasks", true, state.tasks.filter((task) => task.status !== "done").length);
  }

  function renderFeed(state) {
    return section("Live feed", [
      state.feed.length === 0 ? el("p", { class: "muted", text: "No activity yet." }) : null,
      ...state.feed.map((item) =>
        foldItem(`feed-${item.id ?? item.created_at}`, item.summary, [
          el("p", {
            class: "muted",
            text: [item.author, new Date(item.created_at).toLocaleTimeString(), item.files.join(", ")].filter(Boolean).join(" · "),
          }),
        ]),
      ),
    ], "feed", false);
  }

  function renderTeam(state) {
    return el("div", {}, [
      el("header", { class: "team-header" }, [
        el("h1", { text: state.team.name }),
        el("div", { class: "invite" }, [
          el("span", { class: "muted", text: "Invite code" }),
          el("code", { text: state.team.invite_code }),
          el("button", {
            type: "button",
            class: "link",
            text: "Copy",
            onclick: () => {
              navigator.clipboard.writeText(state.team.invite_code);
            },
          }),
        ]),
        el("div", { class: "row" }, [
          el("button", {
            type: "button",
            text: "Open board",
            onclick: () => vscode.postMessage({ type: "openBoard" }),
          }),
          el("button", {
            type: "button",
            class: "secondary",
            text: "Open team map",
            onclick: () => vscode.postMessage({ type: "openMap" }),
          }),
        ]),
      ]),
      renderWorkspace(state),
      renderInbox(state),
      renderAgentChat(state),
      renderPulse(state),
      renderAssumptions(state),
      renderDecisions(state),
      renderTasks(state),
      renderFeed(state),
    ]);
  }

  function renderAccount(state) {
    return el("footer", { class: "account" }, [
      el("span", { class: "muted", text: state.user.email }),
      el("button", {
        type: "button",
        class: "link",
        text: "Log out",
        onclick: () => vscode.postMessage({ type: "signOut" }),
      }),
    ]);
  }

  const drafts = new Map();
  const openDecisions = new Set();

  // A background refresh must not wipe out what the user is typing, so plain re-renders
  // leave form fields alone while one of them has focus.
  function isEditing() {
    const active = document.activeElement;
    return active && active.tagName === "INPUT";
  }

  function render(state) {
    const focusedDraft = document.activeElement?.tagName === "TEXTAREA" ? document.activeElement.id : null;
    const caret = focusedDraft ? document.activeElement.selectionStart : 0;
    root.replaceChildren(
      ...[
        state.error ? el("p", { class: "error", role: "alert", text: state.error }) : null,
        state.notice ? el("p", { class: "notice", role: "status", text: state.notice }) : null,
        !state.user ? renderSignedOut() : state.team ? renderTeam(state) : renderTeamChoice(state),
        state.user ? renderAccount(state) : null,
      ].filter(Boolean),
    );
    if (focusedDraft) {
      const restored = document.getElementById(focusedDraft);
      if (restored) {
        restored.focus();
        restored.setSelectionRange(caret, caret);
      }
    }
  }

  window.addEventListener("message", (event) => {
    const previous = lastState;
    lastState = event.data;
    const sameScreen = previous && !previous.user === !lastState.user && !previous.team === !lastState.team;
    const quiet = !lastState.error && !lastState.notice;
    if (isEditing() && sameScreen && quiet) return;
    render(lastState);
  });

  vscode.postMessage({ type: "ready" });
})();
