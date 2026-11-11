// The Terminal screen: real terminals for Claude Code, Codex or a plain shell in a connected folder.
// Bundled with xterm.js. It can only ask the app for one of three fixed kinds of terminal in a
// folder from the person's own list; it never sends a command line.
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

const api = window.hackyTerminal;
const root = document.getElementById("root");

const KINDS = [
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["shell", "Shell"],
];
const MAX = 6;
const sessions = new Map(); // id -> { id, label, term, fit, holder, ended }
let activeId = null;
let folders = [];
let folder = "";
let notice = "";

const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "onclick" || key === "onchange") node[key] = value;
    else if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) if (child) node.appendChild(child);
  return node;
};

const header = el("div", { class: "bar" });
const hint = el("div", { class: "hint", role: "status" });
const stage = el("div", { class: "stage" });
root.append(header, hint, stage);

function renderHeader() {
  header.textContent = "";
  const tabs = el("div", { class: "tabs" });
  for (const session of sessions.values()) {
    tabs.appendChild(
      el("span", { class: `tab${session.id === activeId ? " on" : ""}${session.ended ? " ended" : ""}` }, [
        Object.assign(el("button", { type: "button", class: "name", text: session.label + (session.ended ? " (ended)" : "") }), { onclick: () => show(session.id) }),
        Object.assign(el("button", { type: "button", class: "x", "aria-label": `Close ${session.label}`, text: "×" }), { onclick: () => closeSession(session.id) }),
      ]),
    );
  }
  const select = el("select", { "aria-label": "Folder" });
  for (const item of folders) {
    const option = el("option", { value: item.path, text: item.name });
    if (item.path === folder) option.selected = true;
    select.appendChild(option);
  }
  select.onchange = () => {
    folder = select.value;
    renderHint();
  };
  const buttons = KINDS.map(([kind, label]) =>
    Object.assign(el("button", { type: "button", class: "new", "data-kind": kind, text: `+ ${label}`, ...(folders.length ? {} : { disabled: "" }) }), { onclick: () => openSession(kind, label) }),
  );
  header.append(tabs, el("span", { class: "grow" }), select, ...buttons);
}

function renderHint() {
  const current = folders.find((item) => item.path === folder);
  if (folders.length === 0) hint.textContent = "Add a project folder in the sidebar first, then open a terminal in it.";
  else if (notice) hint.textContent = notice;
  else if (current && current.status !== "connected") hint.textContent = "This folder isn't connected to Hacky yet (or is out of date). Connect it in the sidebar so the agent can use the team tools.";
  else hint.textContent = "";
}

function show(id) {
  activeId = id;
  for (const session of sessions.values()) session.holder.hidden = session.id !== id;
  const session = sessions.get(id);
  if (session) {
    session.fit.fit();
    session.term.focus();
  }
  renderHeader();
}

async function openSession(kind, label) {
  notice = "";
  if (!folder) return;
  const result = await api.open(kind, folder);
  if (typeof result !== "number") {
    notice = result && result.error ? result.error : "Couldn't open a terminal.";
    renderHint();
    return;
  }
  const holder = el("div", { class: "term" });
  stage.appendChild(holder);
  const term = new Terminal({ fontFamily: "Cascadia Mono, Consolas, monospace", fontSize: 13, cursorBlink: true, scrollback: 5000, theme: { background: "#1e1e1e", foreground: "#cccccc" } });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(holder);
  const session = { id: result, label: `${label} · ${folders.find((item) => item.path === folder)?.name ?? ""}`, term, fit, holder, ended: false };
  sessions.set(result, session);
  term.onData((data) => api.input(result, data));
  term.onResize(({ cols, rows }) => api.resize(result, cols, rows));
  show(result);
  api.resize(result, term.cols, term.rows);
  renderHint();
}

function closeSession(id) {
  const session = sessions.get(id);
  if (!session) return;
  api.close(id);
  session.term.dispose();
  session.holder.remove();
  sessions.delete(id);
  if (activeId === id) {
    const next = sessions.keys().next().value;
    activeId = null;
    if (next !== undefined) show(next);
  }
  renderHeader();
}

api.onData(({ id, data }) => sessions.get(id)?.term.write(data));
api.onExit(({ id }) => {
  const session = sessions.get(id);
  if (!session) return;
  session.ended = true;
  session.term.write("\r\n\x1b[2m[The terminal has ended. Close this tab, or open a new one.]\x1b[0m\r\n");
  renderHeader();
});

// The app's state arrives as for every screen. Only the folder list matters here.
window.addEventListener("message", (event) => {
  const state = event.data;
  if (!state || !Array.isArray(state.folders)) return;
  folders = state.folders;
  if (!folders.some((item) => item.path === folder)) folder = (folders.find((item) => item.active) ?? folders[0])?.path ?? "";
  renderHeader();
  renderHint();
});

new ResizeObserver(() => {
  const session = sessions.get(activeId);
  if (session) session.fit.fit();
}).observe(stage);

renderHeader();
renderHint();
window.hackyTerminalReady = true;
const host = window.acquireVsCodeApi();
host.postMessage({ type: "ready" });
