// Hacky Skills: find a skill on GitHub, read it, install it, and share it with the team.
// Everything here comes from GitHub or teammates, so it is untrusted: it is rendered through
// textContent, never as HTML.
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");
  root.classList.add("hk");
  let draft = "";

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "onclick" || key === "onsubmit" || key === "oninput") node[key] = value;
      else if (key === "text") node.textContent = value;
      else if (key === "class") node.className = value;
      else node.setAttribute(key, value);
    }
    for (const child of children) if (child) node.appendChild(child);
    return node;
  }

  const post = (message) => () => vscode.postMessage(message);
  const button = (label, cls, onclick, extra = {}) => Object.assign(el("button", { type: "button", class: cls, text: label, ...extra }), { onclick });
  const short = (sha) => sha.slice(0, 7);
  const where = (skill) => `${skill.repo}${skill.path ? `/${skill.path}` : ""} @ ${short(skill.sha)}`;
  const kb = (bytes) => (bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`);

  const LOCAL_TEXT = { none: "Not installed", current: "Installed", outdated: "Installed, older version", manual: "You have your own copy" };

  function renderLookupForm() {
    const input = el("input", { type: "url", id: "skill-url", placeholder: "github.com/owner/repo  or a link to a folder in it", "aria-label": "GitHub link to a skill", autocomplete: "off" });
    input.value = draft;
    input.oninput = () => (draft = input.value);
    return el("form", { class: "lookup" }, [input, el("button", { type: "submit", class: "btn pri", text: "Look up" })]);
  }

  function renderChoices(lookup) {
    return el("section", { class: "card" }, [
      el("h2", { text: "Several skills found" }),
      el("p", { class: "hint", text: `${lookup.repo} @ ${short(lookup.sha)}. Choose one to read first.` }),
      ...lookup.candidates.map((candidate) =>
        el("div", { class: "row" }, [
          el("span", { class: "grow tr", title: candidate.path, text: candidate.name }),
          el("span", { class: "hint tr", text: candidate.path }),
          button("Read", "btn", post({ type: "pickSkill", path: candidate.path })),
        ]),
      ),
      el("div", { class: "actions" }, [button("Cancel", "btn", post({ type: "cancelSkill" }))]),
    ]);
  }

  function renderPreview(state) {
    const { preview } = state.skills.lookup;
    const canInstall = state.workspace !== "none";
    const share = el("input", { type: "checkbox", id: "skill-share" });
    share.checked = true;
    return el("section", { class: "card" }, [
      el("h2", { text: preview.name }),
      el("p", { class: "hint", text: where(preview) }),
      el("p", { class: "warn", text: "A skill is a set of instructions your agent will follow. Read it before installing. Any scripts it includes are copied, but Hacky never runs them." }),
      preview.risky.length
        ? el("p", { class: "warn strong", text: `Not plain text, so look at these closely: ${preview.risky.join(", ")}` })
        : null,
      el("details", {}, [
        el("summary", { text: `${preview.files.length} file${preview.files.length === 1 ? "" : "s"}` }),
        el("ul", { class: "files" }, preview.files.map((file) => el("li", { text: `${file.path}  (${kb(file.size)})` }))),
      ]),
      el("pre", { class: "skill-text", text: preview.text + (preview.truncated ? "\n\n[Shortened. The full file is in the repo.]" : "") }),
      state.skills.fromTeam ? null : el("label", { class: "share", for: "skill-share" }, [share, document.createTextNode("Share with the team")]),
      canInstall ? null : el("p", { class: "hint", text: "Choose a project folder first, so there is somewhere to install it." }),
      el("div", { class: "actions" }, [
        button("Install", "btn pri", () => vscode.postMessage({ type: "installSkill", share: !state.skills.fromTeam && share.checked }), canInstall ? {} : { disabled: "" }),
        button("Cancel", "btn", post({ type: "cancelSkill" })),
      ]),
    ]);
  }

  function renderTeam(state) {
    const skills = state.skills.team;
    return el("section", {}, [
      el("h2", { text: "Team skills" }),
      skills.length === 0 ? el("p", { class: "hint", text: "Nothing shared yet. Look up a skill above and tick \"Share with the team\"." }) : null,
      ...skills.map((skill) => {
        const actions = [];
        if (skill.local === "none" || skill.local === "outdated") {
          actions.push(button(skill.local === "none" ? "Install" : "Update", "btn pri", post({ type: "previewTeamSkill", skillId: skill.id })));
        }
        if (skill.local === "current" || skill.local === "outdated") {
          actions.push(button("Remove here", "btn", post({ type: "removeLocalSkill", name: skill.name }), { "aria-label": `Remove ${skill.name} from this folder` }));
        }
        actions.push(button("Unshare", "lnk", post({ type: "unshareSkill", skillId: skill.id }), { "aria-label": `Unshare ${skill.name}` }));
        return el("div", { class: "card skill" }, [
          el("div", { class: "row" }, [el("strong", { class: "grow tr", text: skill.name }), el("span", { class: `badge ${skill.local}`, text: LOCAL_TEXT[skill.local] })]),
          el("p", { class: "hint tr", text: `${where(skill)}${skill.addedBy ? `, added by ${skill.addedBy}` : ""}` }),
          el("div", { class: "actions" }, actions),
        ]);
      }),
    ]);
  }

  function render(state) {
    const hadFocus = document.activeElement && document.activeElement.id === "skill-url";
    root.textContent = "";
    if (!state.user || !state.team) {
      root.appendChild(el("div", { class: "page" }, [el("h1", { text: "Skills" }), el("p", { class: "hint", text: "Log in and choose a team in the sidebar first." })]));
      return;
    }
    const form = renderLookupForm();
    form.onsubmit = (event) => {
      event.preventDefault();
      if (draft.trim()) vscode.postMessage({ type: "previewSkill", url: draft.trim() });
    };
    const lookup = state.skills.lookup;
    root.appendChild(
      el("div", { class: "page" }, [
        el("h1", { text: "Skills" }),
        el("p", { class: "hint", text: state.folder ? `Installing into ${state.folder}` : "Skills are installed into your project's .claude/skills folder." }),
        state.error ? el("p", { class: "msg err", role: "alert", text: state.error }) : null,
        state.notice ? el("p", { class: "msg ok", role: "status", text: state.notice }) : null,
        form,
        lookup && lookup.kind === "choose" ? renderChoices(lookup) : null,
        lookup && lookup.kind === "preview" ? renderPreview(state) : null,
        renderTeam(state),
      ]),
    );
    if (hadFocus) document.getElementById("skill-url").focus();
  }

  window.addEventListener("message", (event) => render(event.data));
  vscode.postMessage({ type: "ready" });
})();
