import assert from "node:assert/strict";
import { test } from "node:test";
import { assetPath, pageHtml, parseMessage } from "./host.js";

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
  assert.equal(parseMessage({ type: "showTab", tab: "settings" }), null);
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
