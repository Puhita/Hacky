// The tab bar above the board and map. It only tells the app which tab was clicked.
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
  window.addEventListener("message", function (event) {
    const active = event.data && event.data.activeTab;
    buttons.forEach(function (button, index) { button.classList.toggle("on", tabs[index][0] === active); });
  });
  host.postMessage({ type: "ready" });
})();
