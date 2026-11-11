import assert from "node:assert/strict";
import { test } from "node:test";
import { addFolder, assetPath, pageHtml, parseMessage, parseTerminalOpen, removeFolder, TERMINAL_COMMAND, terminalEnv } from "./host.js";

test("messages for the controller pass through, unknown ones are dropped", () => {
  assert.deepEqual(parseMessage({ type: "openMap" }), { kind: "controller", message: { type: "openMap" } });
  assert.equal(parseMessage({ type: "runShell", command: "calc" }), null);
  assert.equal(parseMessage("openMap"), null);
  assert.equal(parseMessage(null), null);
  assert.equal(parseMessage({ type: 5 }), null);
});

test("the app's own messages are recognised", () => {
  assert.deepEqual(parseMessage({ type: "chooseFolder" }), { kind: "chooseFolder" });
  assert.deepEqual(parseMessage({ type: "showTab", tab: "map" }), { kind: "showTab", tab: "map" });
  assert.deepEqual(parseMessage({ type: "showTab", tab: "skills" }), { kind: "showTab", tab: "skills" });
  assert.deepEqual(parseMessage({ type: "showTab", tab: "git" }), { kind: "showTab", tab: "git" });
  assert.deepEqual(parseMessage({ type: "loadGit" }), { kind: "controller", message: { type: "loadGit" } });
  assert.equal(parseMessage({ type: "showTab", tab: "settings" }), null);
  assert.deepEqual(parseMessage({ type: "previewSkill", url: "o/r" }), { kind: "controller", message: { type: "previewSkill", url: "o/r" } });
});

test("only the copied screens and stylesheets can be read", () => {
  assert.equal(assetPath("/media/sidebar.js"), "media/sidebar.js");
  assert.equal(assetPath("/static/theme.css"), "static/theme.css");
  assert.equal(assetPath("/main.cjs"), null);
  assert.equal(assetPath("/media/../main.cjs"), null);
  assert.equal(assetPath("/media/..%2Fmain.cjs"), null);
  assert.equal(assetPath("/media/icon.png"), null);
  assert.equal(assetPath("/media/sub/sidebar.js"), null);
});

test("a page loads only the app's own files under a strict policy", () => {
  const html = pageHtml("board");
  assert.match(html, /default-src 'none'; style-src 'self'; script-src 'self';/);
  assert.match(html, /app:\/\/ui\/media\/board\.js/);
  assert.match(html, /app:\/\/ui\/static\/theme\.css/);
  assert.doesNotMatch(html, /https?:/);
});

test("folder messages carry a path, and nothing else is accepted", () => {
  assert.deepEqual(parseMessage({ type: "connectFolder", path: "D:\Game", editors: ["cursor"] }), { kind: "connectFolder", path: "D:\Game", editors: ["cursor"] });
  assert.deepEqual(parseMessage({ type: "removeFolder", path: "D:\Game" }), { kind: "removeFolder", path: "D:\Game" });
  assert.equal(parseMessage({ type: "connectFolder" }), null);
  assert.equal(parseMessage({ type: "removeFolder", path: 5 }), null);
});

test("folders are added once and removed by path", () => {
  assert.deepEqual(addFolder(["a"], "b"), ["a", "b"]);
  assert.deepEqual(addFolder(["a"], "a"), ["a"]);
  assert.deepEqual(removeFolder(["a", "b"], "a"), ["b"]);
  assert.deepEqual(removeFolder(["a"], "z"), ["a"]);
});

test("a terminal can only be one of three kinds, in a folder from the person's own list", () => {
  const folders = ["D:/Game", "D:/Tools"];
  assert.deepEqual(parseTerminalOpen({ kind: "claude", folder: "D:/Game" }, folders), { kind: "claude", folder: "D:/Game" });
  assert.deepEqual(parseTerminalOpen({ kind: "shell", folder: "D:/Tools" }, folders), { kind: "shell", folder: "D:/Tools" });
  assert.equal(parseTerminalOpen({ kind: "claude", folder: "C:/Windows" }, folders), null, "a folder that isn't theirs");
  assert.equal(parseTerminalOpen({ kind: "powershell -c calc", folder: "D:/Game" }, folders), null, "no command of its own");
  assert.equal(parseTerminalOpen({ kind: "claude" }, folders), null);
  assert.equal(parseTerminalOpen("claude", folders), null);
  assert.equal(parseTerminalOpen(null, folders), null);
  assert.deepEqual(TERMINAL_COMMAND, { claude: "claude", codex: "codex", shell: null });
});

test("a terminal starts with the person's environment, minus Electron's", () => {
  const env = terminalEnv({ PATH: "C:/bin", ELECTRON_RUN_AS_NODE: "1", ELECTRON_FOO: "x", HACKY_SMOKE_DIR: "t", HOME: "h", EMPTY: undefined });
  assert.deepEqual(env, { PATH: "C:/bin", HOME: "h" });
});

test("the terminal page loads its own script and styles under the strict policy", () => {
  const html = pageHtml("terminal");
  assert.match(html, /app:\/\/ui\/static\/terminal\.js/);
  assert.match(html, /app:\/\/ui\/static\/xterm\.css/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'self';/);
  assert.match(html, /style-src 'self' 'unsafe-inline'/, "xterm needs inline styles");
  assert.doesNotMatch(pageHtml("board"), /unsafe-inline/, "the other screens stay strict");
  assert.equal(assetPath("/static/terminal.js"), "static/terminal.js");
  assert.equal(assetPath("/static/xterm.css"), "static/xterm.css");
});
