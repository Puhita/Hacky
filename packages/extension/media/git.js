// Hacky Git: the connected folder's branches and commits as a graph. Read-only. Commit messages,
// branch names and author names come from the repo, so they are untrusted: everything is rendered
// through textContent, never as HTML.
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");
  root.classList.add("hk");

  const ROW = 30;
  const LANE = 16;
  const PAD = 12;
  const COLORS = ["#3794ff", "#89d185", "#d18616", "#b180d7", "#e5686a", "#4fc1c9", "#d7ba7d", "#c586c0"];
  const colour = (slot) => COLORS[slot % COLORS.length];
  const SVG_NS = "http://www.w3.org/2000/svg";

  // The folder the graph was last asked for, so it loads once per folder and again on Refresh.
  let requestedFor = null;

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "onclick") node[key] = value;
      else if (key === "text") node.textContent = value;
      else if (key === "class") node.className = value;
      else node.setAttribute(key, value);
    }
    for (const child of children) if (child) node.appendChild(child);
    return node;
  }
  const svg = (tag, attrs = {}, children = []) => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    for (const child of children) node.appendChild(child);
    return node;
  };

  function ago(unix) {
    const seconds = Math.max(0, Math.floor(Date.now() / 1000 - unix));
    const units = [["y", 31536000], ["mo", 2592000], ["d", 86400], ["h", 3600], ["m", 60]];
    for (const [label, size] of units) if (seconds >= size) return `${Math.floor(seconds / size)}${label} ago`;
    return "just now";
  }

  // The lines and dots. One path per line to a parent, in the colour of the lane it runs in.
  function drawGraph(graph) {
    const x = (lane) => PAD + lane * LANE;
    const y = (row) => row * ROW + ROW / 2;
    const height = graph.commits.length * ROW;
    const width = PAD * 2 + Math.max(1, graph.lanes) * LANE;
    const index = new Map(graph.commits.map((commit, row) => [commit.hash, row]));
    const picture = svg("svg", { width, height, viewBox: `0 0 ${width} ${height}`, class: "graph", "aria-hidden": "true" });
    graph.commits.forEach((commit, row) => {
      for (const edge of commit.edges) {
        const target = index.get(edge.parent);
        const x1 = x(commit.lane);
        const xs = x(edge.slot);
        const y1 = y(row);
        const toBottom = target === undefined;
        const y2 = toBottom ? height : y(target);
        const x2 = toBottom ? xs : x(graph.commits[target].lane);
        let d;
        if (x1 === xs && xs === x2) d = `M${x1} ${y1}V${y2}`;
        else if (toBottom || target === row + 1) d = `M${x1} ${y1}C${x1} ${y1 + ROW / 2} ${x2} ${y2 - ROW / 2} ${x2} ${y2}`;
        else d = `M${x1} ${y1}C${x1} ${y1 + ROW / 2} ${xs} ${y1 + ROW / 2} ${xs} ${y1 + ROW}V${y2 - ROW}C${xs} ${y2 - ROW / 2} ${x2} ${y2 - ROW / 2} ${x2} ${y2}`;
        picture.appendChild(svg("path", { d, fill: "none", stroke: colour(edge.slot), "stroke-width": "2", "stroke-linecap": "round" }));
      }
    });
    graph.commits.forEach((commit, row) => {
      const merge = commit.parents.length > 1;
      picture.appendChild(svg("circle", { cx: x(commit.lane), cy: y(row), r: merge ? 4 : 5, fill: merge ? "var(--bg)" : colour(commit.lane), stroke: colour(commit.lane), "stroke-width": "2" }));
    });
    return picture;
  }

  function refChip(ref, graph) {
    if (ref === "HEAD") return el("span", { class: "chip head", text: graph.detached ? "HEAD (detached)" : "HEAD" });
    const tag = ref.startsWith("tag: ");
    const remote = !tag && graph.branches.some((branch) => branch.remote && branch.name === ref);
    return el("span", { class: `chip ${tag ? "tag" : remote ? "remote" : "local"}`, text: tag ? ref.slice(5) : ref });
  }

  // A person's name from the repo, matched to a teammate when the names are the same.
  function person(author, members) {
    const match = (members || []).find((member) => member.name.trim().toLowerCase() === author.trim().toLowerCase());
    return el("span", { class: `who${match && match.me ? " me" : ""}`, title: match ? (match.me ? "You" : "A teammate") : "Not matched to a teammate" }, [
      el("span", { class: `av${match ? " team" : ""}`, text: (author.trim()[0] || "?").toUpperCase() }),
      document.createTextNode(match && match.me ? `${author} (you)` : author),
    ]);
  }

  function renderBranches(graph) {
    const rows = graph.branches.map((branch) => {
      const status = [];
      if (branch.gone) status.push("upstream gone");
      if (branch.ahead) status.push(`${branch.ahead} ahead`);
      if (branch.behind) status.push(`${branch.behind} behind`);
      return el("li", { class: branch.current ? "cur" : "" }, [
        el("span", { class: `chip ${branch.remote ? "remote" : "local"}`, text: branch.name }),
        el("span", { class: "hint", text: [branch.current ? "checked out" : "", ...status, ago(branch.time)].filter(Boolean).join(" · ") }),
      ]);
    });
    return el("aside", { class: "branches" }, [el("h2", { text: `Branches (${graph.branches.length})` }), el("ul", {}, rows)]);
  }

  function renderRows(graph, members) {
    return el(
      "div",
      { class: "rows" },
      graph.commits.map((commit) =>
        el("div", { class: "crow", title: `${commit.hash}\n${new Date(commit.time * 1000).toLocaleString()}` }, [
          ...commit.refs.map((ref) => refChip(ref, graph)),
          el("span", { class: "subject tr", text: commit.subject }),
          person(commit.author, members),
          el("span", { class: "hint nowrap", text: ago(commit.time) }),
          el("code", { class: "sha", text: commit.short }),
        ]),
      ),
    );
  }

  function render(state) {
    root.textContent = "";
    if (!state.user || !state.team) {
      root.appendChild(el("div", { class: "page" }, [el("h1", { text: "Git" }), el("p", { class: "hint", text: "Log in and choose a team in the sidebar first." })]));
      return;
    }
    const folder = state.folder || "";
    if (requestedFor !== folder) {
      requestedFor = folder;
      vscode.postMessage({ type: "loadGit" });
    }
    const { git } = state;
    const graph = git.graph;
    const head = graph ? (graph.detached ? "detached HEAD" : graph.head ? `on ${graph.head}` : "no commits yet") : "";
    root.appendChild(
      el("div", { class: "page" }, [
        el("div", { class: "bar" }, [
          el("h1", { text: graph ? `Git: ${graph.repo}` : "Git" }),
          el("span", { class: "hint grow", text: head }),
          Object.assign(el("button", { type: "button", class: "btn", text: "Refresh" }), { onclick: () => vscode.postMessage({ type: "loadGit" }) }),
        ]),
        git.status === "error" ? el("p", { class: "msg err", role: "alert", text: git.error }) : null,
        git.status === "idle" ? el("p", { class: "hint", text: "Reading the repository..." }) : null,
        graph && graph.commits.length === 0 ? el("p", { class: "hint", text: "No commits yet." }) : null,
        graph && graph.commits.length > 0
          ? el("div", { class: "layout" }, [
              el("div", { class: "history" }, [
                el("div", { class: "scroll" }, [drawGraph(graph), renderRows(graph, state.members)]),
                graph.capped ? el("p", { class: "hint", text: "Showing the newest 300 commits." }) : null,
              ]),
              renderBranches(graph),
            ])
          : null,
        graph ? el("p", { class: "hint", text: "Read-only. Remote branches are as of your last git fetch." }) : null,
      ]),
    );
  }

  window.addEventListener("message", (event) => render(event.data));
  vscode.postMessage({ type: "ready" });
})();
