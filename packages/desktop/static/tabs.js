// The tab bar above the board and map. It only tells the app which tab was clicked, and whether
// to hide or show the sidebar.
(function () {
  const host = acquireVsCodeApi();
  const bar = document.getElementById("bar");
  const tabs = [["board", "Board"], ["map", "Map"], ["skills", "Skills"], ["git", "Git"], ["terminal", "Terminal"]];
  const buttons = tabs.map(function (tab) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = tab[1];
    button.addEventListener("click", function () { host.postMessage({ type: "showTab", tab: tab[0] }); });
    bar.appendChild(button);
    return button;
  });

  // Hides or shows the sidebar. It sits before the tabs, outside #bar.
  let collapsed = false;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "toggle";
  toggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h18v16H3z"/><path d="M9 4v16"/><path class="arrow" d="M15 10l-2 2 2 2"/></svg>';
  const label = function () {
    const text = collapsed ? "Show the sidebar" : "Hide the sidebar";
    toggle.title = text;
    toggle.setAttribute("aria-label", text);
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.classList.toggle("collapsed", collapsed);
  };
  label();
  toggle.addEventListener("click", function () { host.postMessage({ type: "setSidebarCollapsed", collapsed: !collapsed }); });
  document.body.insertBefore(toggle, bar);

  window.addEventListener("message", function (event) {
    const data = event.data || {};
    if (typeof data.activeTab === "string") {
      buttons.forEach(function (button, index) { button.classList.toggle("on", tabs[index][0] === data.activeTab); });
    }
    if (typeof data.sidebarCollapsed === "boolean") {
      collapsed = data.sidebarCollapsed;
      label();
    }
  });
  host.postMessage({ type: "ready" });
})();
