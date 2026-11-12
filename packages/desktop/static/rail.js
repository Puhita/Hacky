// The narrow rail shown while the sidebar is hidden: a button to show it again, how many things
// need the person, and the tabs as icons.
(function () {
  const host = acquireVsCodeApi();
  const root = document.getElementById("root");
  const SVG = "http://www.w3.org/2000/svg";
  const ICONS = {
    expand: ["M3 4h18v16H3z", "M9 4v16", "M13 10l2 2-2 2"],
    board: ["M3 4h18v16H3z", "M9 4v16", "M15 4v16"],
    map: ["M6 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0", "M18 8m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0", "M10 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0", "M8 7l8 1", "M7 8l2 8", "M16 10l-5 6"],
    skills: ["M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z"],
    git: ["M6 5m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0", "M6 19m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0", "M18 7m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0", "M6 7v10", "M18 9c0 5-12 3-12 8"],
    terminal: ["M3 5h18v14H3z", "M7 10l3 2-3 2", "M12 15h5"],
  };
  const icon = (name) => {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    for (const d of ICONS[name]) {
      const path = document.createElementNS(SVG, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    return svg;
  };
  const button = (label, iconName, onclick, extra) => {
    const node = document.createElement("button");
    node.type = "button";
    node.title = label;
    node.setAttribute("aria-label", label);
    node.appendChild(icon(iconName));
    if (extra) node.appendChild(extra);
    node.addEventListener("click", onclick);
    return node;
  };

  // Shows the sidebar; in a narrow window, where the sidebar sits beside the rail, it hides it again.
  let collapsed = true;
  let needs = 0;
  const show = () => host.postMessage({ type: "setSidebarCollapsed", collapsed: !collapsed });
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.hidden = true;
  const expand = button("Show the sidebar", "expand", show, badge);
  expand.className = "expand";
  const tabs = [["board", "Board"], ["map", "Map"], ["skills", "Skills"], ["git", "Git"], ["terminal", "Terminal"]];
  const tabButtons = tabs.map(([id, label]) => button(label, id, () => host.postMessage({ type: "showTab", tab: id })));
  const nav = document.createElement("nav");
  nav.setAttribute("aria-label", "Screens");
  nav.append(...tabButtons);
  root.append(expand, nav);

  window.addEventListener("message", (event) => {
    const data = event.data || {};
    if (typeof data.activeTab === "string") {
      tabButtons.forEach((node, index) => {
        const on = tabs[index][0] === data.activeTab;
        node.classList.toggle("on", on);
        node.setAttribute("aria-current", on ? "page" : "false");
      });
    }
    if (typeof data.needs === "number") needs = data.needs;
    if (typeof data.sidebarCollapsed === "boolean") collapsed = data.sidebarCollapsed;
    badge.hidden = needs <= 0 || !collapsed;
    badge.textContent = needs > 99 ? "99+" : String(needs);
    expand.classList.toggle("open", !collapsed);
    expand.setAttribute("aria-expanded", String(!collapsed));
    expand.title = !collapsed ? "Hide the sidebar" : needs > 0 ? `Show the sidebar (${needs} need you)` : "Show the sidebar";
    expand.setAttribute("aria-label", expand.title);
  });
  host.postMessage({ type: "ready" });
})();
