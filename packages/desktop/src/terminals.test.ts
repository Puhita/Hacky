// Runs real terminals, so it needs Windows with PowerShell.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_TERMINALS } from "./host.js";
import { Terminals } from "./terminals.js";

// Shells can hold their folder for a moment after they are killed. A leftover temp folder is harmless.
function cleanUp(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // Best effort.
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, label: string, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
    await wait(100);
  }
}

test("a shell terminal runs in the folder, takes input and reports its exit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hacky-term-"));
  let output = "";
  const exits: number[] = [];
  const terminals = new Terminals(
    (_id, data) => (output += data),
    (id) => exits.push(id),
  );
  try {
    const id = terminals.open("shell", dir);
    await wait(1500);
    terminals.input(id, "echo hacky-terminal-ok; (Get-Location).Path\r");
    await until(() => output.includes("hacky-terminal-ok"), "the echo");
    assert.ok(output.toLowerCase().includes(dir.split("\\").pop()!.toLowerCase()), "started in the folder");
    terminals.resize(id, 120, 40);
    terminals.input(id, "exit\r");
    await until(() => exits.includes(id), "the exit");
    assert.equal(terminals.firstId(), undefined);
  } finally {
    terminals.closeAll();
    await wait(300);
    cleanUp(dir);
  }
});

test("there is a limit on open terminals, and closing one makes room", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hacky-term-"));
  const terminals = new Terminals(() => undefined, () => undefined);
  try {
    const ids = Array.from({ length: MAX_TERMINALS }, () => terminals.open("shell", dir));
    assert.throws(() => terminals.open("shell", dir), /Close a terminal first/);
    terminals.close(ids[0]);
    assert.doesNotThrow(() => terminals.open("shell", dir));
  } finally {
    terminals.closeAll();
    await wait(500);
    cleanUp(dir);
  }
});

test("input for a terminal that doesn't exist is ignored", () => {
  const terminals = new Terminals(() => undefined, () => undefined);
  assert.doesNotThrow(() => {
    terminals.input(99, "x");
    terminals.resize(99, 10, 10);
    terminals.close(99);
  });
});
