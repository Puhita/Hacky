// Board tour tabs and the theme toggle. The page reads fine without this: every Board view is shown stacked.
(function () {
  const CAPTIONS = {
    messages: "What needs you comes first. Questions, assumptions and agent chats, with a Mine or Everything filter, and the decision log alongside.",
    tasks: "A kanban by status with an owner and files on every card. Add a task in one line, and filter the board by person.",
    team: "Everyone’s chats, what each agent is doing now and recent progress, with a direct link into the Map.",
    activity: "A live feed of questions, decisions, tasks and progress, with the newest events highlighted.",
  };

  const tabs = Array.from(document.querySelectorAll(".tab"));
  const caption = document.getElementById("cap");
  function show(name) {
    for (const tab of tabs) {
      const on = tab.dataset.tab === name;
      tab.classList.toggle("on", on);
      tab.setAttribute("aria-pressed", String(on));
    }
    for (const id of Object.keys(CAPTIONS)) document.getElementById("pane-" + id).hidden = id !== name;
    caption.textContent = CAPTIONS[name];
  }
  for (const tab of tabs) tab.addEventListener("click", () => show(tab.dataset.tab));
  show("messages");

  const root = document.documentElement;
  document.getElementById("theme").addEventListener("click", () => {
    const next = root.dataset.theme === "light" ? "dark" : "light";
    root.dataset.theme = next;
    root.dataset.bsTheme = next;
    try {
      localStorage.setItem("hacky-theme", next);
    } catch (error) {
      // Private windows can refuse storage. The choice just isn't remembered.
    }
  });

  // On a phone, close the menu after a link was tapped.
  const menu = document.getElementById("nav-menu");
  menu.addEventListener("click", (event) => {
    if (event.target.closest(".nav-link") && menu.classList.contains("show")) bootstrap.Collapse.getOrCreateInstance(menu).hide();
  });
})();
