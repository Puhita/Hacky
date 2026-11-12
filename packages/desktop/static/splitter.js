// The handle between the sidebar and the tabs. Dragging it resizes the sidebar; the app lays the
// window out again as it moves and remembers the width. Double-click or Enter hides the sidebar,
// and the arrow keys resize it.
(function () {
  const host = acquireVsCodeApi();
  const root = document.getElementById("root");
  root.tabIndex = 0;
  root.setAttribute("role", "separator");
  root.setAttribute("aria-orientation", "vertical");
  root.setAttribute("aria-label", "Resize the sidebar. Double-click to hide it.");
  root.title = "Drag to resize. Double-click to hide the sidebar.";

  let dragging = false;
  let pending = null;
  let lastX = 0;
  // The pointer that started the drag; any other pointer is ignored until it ends.
  let pointer = null;
  const ours = (event) => dragging && event.pointerId === pointer;
  const send = (phase, screenX) => host.postMessage({ type: "sidebarDrag", phase, screenX });
  // At most one move per frame, so a fast mouse can't flood the app.
  const flush = () => {
    if (pending !== null && dragging) send("move", pending);
    pending = null;
  };
  const end = (screenX) => {
    if (!dragging) return;
    dragging = false;
    pending = null;
    document.body.classList.remove("dragging");
    send("end", screenX);
  };

  root.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    dragging = true;
    pointer = event.pointerId;
    document.body.classList.add("dragging");
    try {
      root.setPointerCapture(event.pointerId);
    } catch {
      // The app also covers the window with this view while dragging, so moves still arrive.
    }
    lastX = event.screenX;
    send("start", event.screenX);
    event.preventDefault();
  });
  window.addEventListener("pointermove", (event) => {
    if (!ours(event)) return;
    // The button was let go somewhere we didn't hear about.
    if (event.buttons === 0) return end(event.screenX);
    if (pending === null) requestAnimationFrame(flush);
    pending = event.screenX;
    lastX = event.screenX;
  });
  window.addEventListener("pointerup", (event) => ours(event) && end(event.screenX));
  window.addEventListener("pointercancel", (event) => ours(event) && end(event.screenX));
  root.addEventListener("lostpointercapture", (event) => ours(event) && end(lastX));
  window.addEventListener("blur", () => end(lastX));
  // The app ended the drag on its own (the window lost focus, or it heard nothing for a while).
  window.addEventListener("message", (event) => {
    if (event.data && event.data.dragging === false && dragging) {
      dragging = false;
      pending = null;
      document.body.classList.remove("dragging");
    }
  });
  root.addEventListener("dblclick", () => host.postMessage({ type: "setSidebarCollapsed", collapsed: true }));
  root.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 64 : 16;
    if (event.key === "ArrowLeft") host.postMessage({ type: "sidebarNudge", by: -step });
    else if (event.key === "ArrowRight") host.postMessage({ type: "sidebarNudge", by: step });
    else if (event.key === "Enter") host.postMessage({ type: "setSidebarCollapsed", collapsed: true });
    else return;
    event.preventDefault();
  });
})();
