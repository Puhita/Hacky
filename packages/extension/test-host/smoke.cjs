// Runs inside a real VS Code: the extension must load and its sidebar must open.
const assert = require("node:assert/strict");
const vscode = require("vscode");

exports.run = async function run() {
  const extension = vscode.extensions.getExtension("hacky.hacky");
  assert.ok(extension, "the extension is installed");

  console.log(`VS Code ${vscode.version}, Node ${process.versions.node}, WebSocket: ${typeof WebSocket}`);
  assert.equal(typeof WebSocket, "function", "Realtime needs a global WebSocket in the extension host");

  await vscode.commands.executeCommand("workbench.view.extension.hacky");
  await vscode.commands.executeCommand("hacky.sidebar.focus");
  await new Promise((resolve) => setTimeout(resolve, 3000));

  assert.equal(extension.isActive, true, "opening the sidebar activates the extension");
  console.log("Sidebar opened and the extension activated.");
};
