// Hacky Board: the team's tasks, messages, people and activity in one wide editor tab.
// Everything here comes from teammates and agents, so it is untrusted: it is rendered through
// textContent, never as HTML.
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");
  let lastState = null;
  let pending = false;

  const saved = vscode.getState() ?? {};
  let tab = saved.tab ?? "tasks";
  let messageFilter = saved.messageFilter ?? "mine";
  const folds = { ...(saved.folds ?? {}) };
  const drafts = new Map();
  const persist = () => vscode.setState({ tab, messageFilter, folds });

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

  const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

  // ---- Small pieces ----

  function button(text, onclick, className = "") {
    return el("button", { type: "button", class: className, text, onclick });
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

  // A <details> whose open state is remembered. The summary is one truncated line while folded.
  function fold(key, defaultOpen, headline, badge, bodyChildren) {
    const node = el("details", { class: "fold" }, [
      el("summary", {}, [badge, el("span", { class: "headline", text: headline })].filter(Boolean)),
      el("div", { class: "fold-body" }, bodyChildren),
    ]);
    node.open = key in folds ? folds[key] : defaultOpen;
    node.ontoggle = () => {
      if (folds[key] === node.open) return;
      folds[key] = node.open;
      persist();
    };
    return node;
  }

  const card = (children) => el("article", { class: "card" }, children);
  const empty = (text) => el("p", { class: "empty", text });
  const badge = (text, kind = "") => el("span", { class: `badge ${kind}`.trim(), text });

  // ---- Tasks ----

  const TASK_COLUMNS = [
    ["todo", "To do"],
    ["in_progress", "In progress"],
    ["done", "Done"],
  ];

  function renderTask(task) {
    const meta = [task.owner, (task.files ?? []).join(", ")].filter(Boolean).join(" · ");
    return card([el("p", { class: "task-title", text: task.title }), meta ? el("p", { class: "muted", text: meta }) : null]);
  }

  function renderTasks(state) {
    const title = el("input", { type: "text", name: "title", "aria-label": "New task", placeholder: "New task" });
    const add = () => {
      if (title.value.trim() === "") return;
      vscode.postMessage({ type: "addTask", title: title.value });
    };
    title.onkeydown = (event) => event.key === "Enter" && add();
    return el("div", {}, [
      el("div", { class: "toolbar" }, [title, button("Add task", add)]),
      el(
        "div",
        { class: "columns" },
        TASK_COLUMNS.map(([status, name]) => {
          const tasks = state.tasks.filter((task) => task.status === status);
          return el("section", { class: "column" }, [
            el("h2", {}, [el("span", { text: name }), badge(String(tasks.length))]),
            ...(tasks.length === 0 ? [empty("Nothing here.")] : tasks.map(renderTask)),
          ]);
        }),
      ),
    ]);
  }

  // ---- Messages ----

  function renderQuestion(question) {
    const answer = draftArea(`answer-${question.id}`, "Your answer");
    const waiting = plural(question.waiting, "agent") + " waiting";
    return card([
      fold(`q-${question.id}`, true, question.text, question.routed_to_me ? badge("For you", "mine") : badge("Team"), [
        question.context ? el("p", { class: "muted", text: question.context }) : null,
        el("p", { class: "muted", text: `From ${question.asked_by_name}. ${waiting}.` }),
        answer,
        button("Send answer", () => sendDraft(answer, (text) => ({ type: "answer", questionId: question.id, text }))),
      ]),
    ]);
  }

  function renderThread(thread) {
    const incoming = thread.direction === "incoming";
    const open = thread.answer === null;
    const who = incoming ? `${thread.other}'s agent asks` : `Your agent asked ${thread.other}`;
    const answer = incoming && open ? draftArea(`peer-${thread.id}`, "Your answer") : null;
    return card([
      fold(`t-${thread.id}`, incoming && open, thread.question, badge(incoming ? "For you" : "Sent", incoming ? "mine" : ""), [
        el("p", { class: "muted", text: who }),
        thread.context ? el("p", { class: "muted", text: thread.context }) : null,
        !open
          ? el("p", { text: thread.answer })
          : !incoming
            ? el("p", { class: "muted", text: `Waiting for ${thread.other}.` })
            : null,
        !open ? el("p", { class: "muted", text: thread.answered_by_agent ? "Answered by their agent." : "Answered by a person." }) : null,
        answer,
        answer ? button("Send answer to agent", () => sendDraft(answer, (text) => ({ type: "answerTeammate", questionId: thread.id, text }))) : null,
      ]),
    ]);
  }

  function renderAssumption(assumption) {
    const reason = draftArea(`reason-${assumption.id}`, "Why it's wrong, or what to do instead");
    return card([
      fold(`a-${assumption.id}`, true, assumption.text, badge("Assumption", "warn"), [
        el("p", { class: "muted", text: `Assumed by ${assumption.author}, for: ${assumption.question}` }),
        el("div", { class: "actions" }, [
          button("Confirm", () => vscode.postMessage({ type: "confirmAssumption", assumptionId: assumption.id })),
        ]),
        reason,
        button("Reject", () => sendDraft(reason, (text) => ({ type: "rejectAssumption", assumptionId: assumption.id, reason: text })), "secondary"),
      ]),
    ]);
  }

  function renderDecision(decision) {
    return card([
      fold(`d-${decision.id}`, false, decision.text, badge("Decision", "done"), [
        decision.question ? el("p", { class: "muted", text: decision.question }) : null,
        el("p", { class: "muted", text: `Decided by ${decision.author}. Change or withdraw it in the sidebar.` }),
      ]),
    ]);
  }

  function group(title, items, render, emptyText) {
    return el("section", { class: "group" }, [
      el("h2", {}, [el("span", { text: title }), badge(String(items.length), items.length > 0 ? "mine" : "")]),
      ...(items.length === 0 ? [empty(emptyText)] : items.map(render)),
    ]);
  }

  function renderMessages(state) {
    const mine = messageFilter === "mine";
    const questions = mine ? state.inbox.filter((question) => question.routed_to_me) : state.inbox;
    const threads = mine ? state.agentChat.filter((thread) => thread.direction === "incoming" && thread.answer === null) : state.agentChat;
    const assumptions = state.assumptions;
    const decisions = mine ? [] : state.decisions;
    const filter = (value, label) =>
      el("button", {
        type: "button",
        class: `chip${messageFilter === value ? " selected" : ""}`,
        "aria-pressed": String(messageFilter === value),
        text: label,
        onclick: () => {
          messageFilter = value;
          persist();
          render(lastState);
        },
      });
    return el("div", {}, [
      el("div", { class: "toolbar" }, [filter("mine", "Needs me"), filter("all", "Everything")]),
      group("Questions", questions, renderQuestion, mine ? "No question is waiting for you." : "No open questions."),
      group("Agent questions", threads, renderThread, mine ? "No agent is waiting for you." : "No agent has asked another agent anything yet."),
      group("Assumptions", assumptions, renderAssumption, "No agent is working on an assumption."),
      mine ? null : group("Decisions", decisions, renderDecision, "No decisions yet."),
    ]);
  }

  // ---- Team ----

  const CHAT_STATE = { active: "Active", idle: "Idle", ended: "Ended" };

  function renderChat(chat) {
    return el("li", { class: `chat ${chat.state}` }, [
      el("span", { class: "dot", "aria-hidden": "true" }),
      el("span", { class: "chat-state", text: CHAT_STATE[chat.state] }),
      el("span", { class: "chat-focus", text: chat.focus ?? chat.task ?? "No focus yet" }),
    ]);
  }

  function renderPerson(member, owner, chats) {
    const shown = chats.filter((chat) => chat.state !== "ended").slice(0, 5);
    return card([
      el("h3", { text: member.me ? `${member.name} (you)` : member.name }),
      el("p", { class: "muted", text: member.chats > 0 ? plural(member.chats, "chat") + " active" : "No chat active" }),
      shown.length > 0 ? el("ul", { class: "chats" }, shown.map(renderChat)) : null,
      member.updates > 0 ? el("p", { class: "muted", text: `${plural(member.updates, "update")} in the last hour:` }) : null,
      ...member.latest.map((summary) => el("p", { text: summary })),
    ]);
  }

  function renderTeam(state) {
    const owners = new Map(((state.map && state.map.owners) || []).map((owner) => [owner.name, owner]));
    return el("div", {}, [
      el("div", { class: "toolbar" }, [
        el("p", { class: "muted grow", text: "Who is on the team and what their agents are doing." }),
        button("Open animated map", () => vscode.postMessage({ type: "openMap" }), "secondary"),
      ]),
      state.pulse.length === 0
        ? empty("Nobody is on the team yet.")
        : el(
            "div",
            { class: "people" },
            state.pulse.map((member) => {
              const owner = owners.get(member.name);
              const chats = owner ? ((state.map && state.map.chats) || []).filter((chat) => chat.ownerId === owner.id) : [];
              return renderPerson(member, owner, chats);
            }),
          ),
    ]);
  }

  // ---- Activity ----

  function renderActivity(state) {
    if (state.feed.length === 0) return empty("No activity yet.");
    return el(
      "div",
      { class: "feed" },
      state.feed.map((item) =>
        card([
          el("p", { text: item.summary }),
          el("p", {
            class: "muted",
            text: [item.author, new Date(item.created_at).toLocaleString(), (item.files ?? []).join(", ")].filter(Boolean).join(" · "),
          }),
        ]),
      ),
    );
  }

  // ---- Page ----

  function counts(state) {
    return {
      tasks: state.tasks.filter((task) => task.status !== "done").length,
      messages:
        state.inbox.filter((question) => question.routed_to_me).length +
        state.agentChat.filter((thread) => thread.direction === "incoming" && thread.answer === null).length +
        state.assumptions.length,
    };
  }

  const TABS = [
    ["tasks", "Tasks", renderTasks],
    ["messages", "Messages", renderMessages],
    ["team", "Team", renderTeam],
    ["activity", "Activity", renderActivity],
  ];

  function renderBoard(state) {
    const number = counts(state);
    const body = TABS.find(([id]) => id === tab) ?? TABS[0];
    return el("div", { class: "board" }, [
      el("header", {}, [
        el("h1", { text: `${state.team.name} board` }),
        el(
          "nav",
          { role: "tablist" },
          TABS.map(([id, label]) =>
            el(
              "button",
              {
                type: "button",
                role: "tab",
                class: `tab${tab === id ? " selected" : ""}`,
                "aria-selected": String(tab === id),
                onclick: () => {
                  tab = id;
                  persist();
                  render(lastState);
                },
              },
              [el("span", { text: label }), number[id] ? badge(String(number[id]), "mine") : null],
            ),
          ),
        ),
      ]),
      el("main", { role: "tabpanel" }, [body[2](state)]),
    ]);
  }

  function renderMessage(text, kind) {
    return el("p", { class: kind, role: kind === "error" ? "alert" : "status", text });
  }

  function render(state) {
    const focusedDraft = document.activeElement?.tagName === "TEXTAREA" ? document.activeElement.id : null;
    const caret = focusedDraft ? document.activeElement.selectionStart : 0;
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
    if (focusedDraft) {
      const restored = document.getElementById(focusedDraft);
      if (restored) {
        restored.focus();
        restored.setSelectionRange(caret, caret);
      }
    }
  }

  // A background refresh must not wipe out what the person is typing, so it waits until they leave the field.
  function isTyping() {
    const tag = document.activeElement?.tagName;
    return tag === "INPUT" || tag === "TEXTAREA";
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
