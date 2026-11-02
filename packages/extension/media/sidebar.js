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

  const section = (title, children) => el("section", {}, [el("h2", { text: title }), ...children]);

  function renderSignedOut() {
    return section("Log in to Hacky", [
      form(
        [
          { name: "email", label: "Email", type: "email" },
          { name: "password", label: "Password", type: "password" },
        ],
        [
          { label: "Log in", send: (values) => ({ type: "signIn", ...values }) },
          { label: "Create account", secondary: true, send: (values) => ({ type: "signUp", ...values }) },
        ],
      ),
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
    other_team: "This folder is connected to a different team.",
  };

  function renderWorkspace(state) {
    const canConnect = state.workspace === "not_connected" || state.workspace === "other_team";
    return section("Workspace", [
      el("p", { text: WORKSPACE_TEXT[state.workspace] }),
      canConnect
        ? el("p", {
            class: "muted",
            text: "This writes .mcp.json and a block in CLAUDE.md, and allows the Hacky tools in .claude/settings.local.json.",
          })
        : null,
      canConnect
        ? el("button", {
            type: "button",
            class: "wide",
            text: "Connect this folder",
            onclick: () => vscode.postMessage({ type: "connectWorkspace" }),
          })
        : null,
    ]);
  }

  function renderQuestion(question) {
    const waiting = question.waiting === 1 ? "1 agent waiting" : `${question.waiting} agents waiting`;
    const answer = el("textarea", { "aria-label": "Your answer", placeholder: "Your answer", rows: "3", id: `answer-${question.id}` });
    answer.value = drafts.get(question.id) ?? "";
    answer.oninput = () => drafts.set(question.id, answer.value);
    return el("article", { class: "card" }, [
      question.routed_to_me ? el("span", { class: "badge", text: "For you" }) : null,
      el("p", { class: "question", text: question.text }),
      question.context ? el("p", { class: "muted", text: question.context }) : null,
      el("p", { class: "muted", text: `From ${question.asked_by_name}. ${waiting}.` }),
      answer,
      el("button", {
        type: "button",
        class: "wide",
        text: "Send answer",
        onclick: () => {
          if (answer.value.trim() === "") return;
          drafts.delete(question.id);
          vscode.postMessage({ type: "answer", questionId: question.id, text: answer.value });
        },
      }),
    ]);
  }

  function renderInbox(state) {
    return section(`Inbox (${state.inbox.length})`, [
      state.inbox.length === 0 ? el("p", { class: "muted", text: "No open questions." }) : null,
      ...state.inbox.map(renderQuestion),
    ]);
  }

  function renderFeed(state) {
    return section("Live feed", [
      state.feed.length === 0 ? el("p", { class: "muted", text: "No activity yet." }) : null,
      ...state.feed.map((item) =>
        el("article", { class: "feed-item" }, [
          el("p", { text: item.summary }),
          el("p", {
            class: "muted",
            text: [item.author, new Date(item.created_at).toLocaleTimeString(), item.files.join(", ")].filter(Boolean).join(" · "),
          }),
        ]),
      ),
    ]);
  }

  function renderTeam(state) {
    return el("div", {}, [
      el("header", {}, [
        el("h1", { text: state.team.name }),
        el("p", { class: "muted", text: `Invite code: ${state.team.invite_code}` }),
        el("button", {
          type: "button",
          class: "secondary",
          text: "Copy invite code",
          onclick: () => navigator.clipboard.writeText(state.team.invite_code),
        }),
      ]),
      renderWorkspace(state),
      renderInbox(state),
      renderFeed(state),
    ]);
  }

  function renderAccount(state) {
    return el("footer", {}, [
      el("p", { class: "muted", text: state.user.email }),
      el("button", {
        type: "button",
        class: "secondary",
        text: "Log out",
        onclick: () => vscode.postMessage({ type: "signOut" }),
      }),
    ]);
  }

  const drafts = new Map();

  // A background refresh must not wipe out what the user is typing, so plain re-renders
  // leave form fields alone while one of them has focus.
  function isEditing() {
    const active = document.activeElement;
    return active && active.tagName === "INPUT";
  }

  function render(state) {
    const focusedAnswer = document.activeElement?.id?.startsWith("answer-") ? document.activeElement.id : null;
    const caret = focusedAnswer ? document.activeElement.selectionStart : 0;
    root.replaceChildren(
      ...[
        state.error ? el("p", { class: "error", role: "alert", text: state.error }) : null,
        state.notice ? el("p", { class: "notice", role: "status", text: state.notice }) : null,
        !state.user ? renderSignedOut() : state.team ? renderTeam(state) : renderTeamChoice(state),
        state.user ? renderAccount(state) : null,
      ].filter(Boolean),
    );
    if (focusedAnswer) {
      const restored = document.getElementById(focusedAnswer);
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
