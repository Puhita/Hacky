// A test run: starts the app against the real project, takes a picture of each screen and writes
// a report, then quits. Set HACKY_SMOKE_DIR to turn it on.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BaseWindow, type WebContentsView } from "electron";
import type { PageName, Tab } from "./host.js";
import type { Terminals } from "./terminals.js";

type Context = {
  dir: string;
  views: Record<PageName, WebContentsView>;
  showTab: (tab: Tab) => void;
  terminals: Terminals;
  quit: () => void;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const TABS = ["board", "map", "skills", "git", "terminal"] as const;

// HACKY_SMOKE_SIZES="800x500,1920x1080" also takes every screen at each of these window sizes
// (named like board@800x500.png). "narrow" squeezes each screen into a 260px column instead, like
// a narrow VS Code side panel. Used to check that the design adapts to any size.
async function shootSizes(views: Record<PageName, WebContentsView>, showTab: (tab: Tab) => void, shoot: (label: string, name: PageName) => Promise<void>): Promise<void> {
  const sizes = (process.env.HACKY_SMOKE_SIZES ?? "").split(",").map((size) => size.trim()).filter(Boolean);
  const win = BaseWindow.getAllWindows()[0];
  if (!win) return;
  // The sidebar and the board have tabs of their own: take each one, then go back to the first.
  const shootInnerTabs = async (name: PageName, selector: string, size: string) => {
    const count = (await views[name].webContents.executeJavaScript(`document.querySelectorAll(${JSON.stringify(selector)}).length`)) as number;
    for (let index = 0; index < count; index++) {
      await views[name].webContents.executeJavaScript(`document.querySelectorAll(${JSON.stringify(selector)})[${index}]?.click()`);
      await wait(700);
      // Wait for two painted frames, so the picture shows the tab just clicked.
      await views[name].webContents.executeJavaScript("new Promise((done) => { requestAnimationFrame(() => requestAnimationFrame(done)); setTimeout(done, 500); })");
      await shoot(`${name}-${index}@${size}`, name);
    }
    if (count) await views[name].webContents.executeJavaScript(`document.querySelectorAll(${JSON.stringify(selector)})[0]?.click()`);
  };
  const shootAll = async (size: string) => {
    await shootInnerTabs("sidebar", ".tabs .tab", size);
    await shoot(`tabs@${size}`, "tabs");
    for (const tab of TABS) {
      showTab(tab);
      await wait(1200);
      if (tab === "board") await shootInnerTabs("board", ".btab", size);
      else await shoot(`${tab}@${size}`, tab);
    }
  };
  for (const size of sizes) {
    if (size === "narrow") {
      const { height } = win.getContentBounds();
      views.sidebar.setBounds({ x: 0, y: 0, width: 260, height });
      views.tabs.setBounds({ x: 260, y: 0, width: 260, height: 40 });
      for (const tab of TABS) views[tab].setBounds({ x: 260, y: 40, width: 260, height: height - 40 });
      await wait(800);
      await shootAll(size);
      continue;
    }
    const match = /^(\d+)x(\d+)$/.exec(size);
    if (!match) continue;
    win.setContentSize(Number(match[1]), Number(match[2]));
    // Resizing lays the views out again; give the screens time to reflow.
    await wait(1500);
    await shootAll(size);
    // Flip the sidebar with the tab bar's button (hidden in a narrow window, shown otherwise), take the rail,
    // the sidebar and a screen that way, then flip it back with the rail's button.
    await views.tabs.webContents.executeJavaScript("document.querySelector('.toggle').click()");
    await wait(1000);
    await shoot(`rail@${size}`, "rail");
    await shoot(`sidebar-toggled@${size}`, "sidebar");
    await shoot(`tabs-toggled@${size}`, "tabs");
    showTab("board");
    await wait(800);
    await shoot(`board-toggled@${size}`, "board");
    await views.rail.webContents.executeJavaScript("document.querySelector('.expand').click()");
    await wait(1000);
  }
}

// Drags the splitter 120px to the right the way a mouse would (as its own pointer, so the real
// mouse can't get in the way), and reports the sidebar's width
// before and after, then puts it back.
export async function dragSplitter(views: Record<PageName, WebContentsView>): Promise<{ before: number; after: number; restored: number }> {
  const win = BaseWindow.getAllWindows()[0];
  const before = views.sidebar.getBounds().width;
  const x = win.getContentBounds().x + views.splitter.getBounds().x + 2;
  const drag = (from: number, to: number) =>
    views.splitter.webContents.executeJavaScript(`(async () => {
      const root = document.getElementById("root");
      // A timer, not an animation frame: frames stop while the window is covered.
      const frame = () => new Promise((done) => setTimeout(done, 20));
      const at = (type, screenX, buttons) => new PointerEvent(type, { bubbles: true, pointerId: 77, pointerType: "mouse", button: 0, buttons, screenX });
      root.dispatchEvent(at("pointerdown", ${from}, 1));
      for (let step = 1; step <= 6; step++) { window.dispatchEvent(at("pointermove", ${from} + ((${to} - ${from}) * step) / 6, 1)); await frame(); await frame(); }
      window.dispatchEvent(at("pointerup", ${to}, 0));
    })()`);
  await drag(x, x + 120);
  await wait(800);
  const after = views.sidebar.getBounds().width;
  const back = win.getContentBounds().x + views.splitter.getBounds().x + 2;
  await drag(back, back - 120);
  await wait(800);
  return { before, after, restored: views.sidebar.getBounds().width };
}

export async function runSmoke({ dir, views, showTab, terminals, quit }: Context): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const problems: string[] = [];
  for (const name of Object.keys(views) as PageName[]) {
    views[name].webContents.on("console-message", (event) => {
      // A ResizeObserver loop note is the browser's harmless warning when a screen is resized.
      if (event.level === "error" && !event.message.startsWith("ResizeObserver loop")) problems.push(`${name}: ${event.message}`);
    });
  }
  await wait(Number(process.env.HACKY_SMOKE_WAIT_MS ?? 8000));
  const report: Record<string, unknown> = {};
  const shoot = async (label: string, name: PageName) => {
    const { webContents } = views[name];
    const image = await webContents.capturePage();
    writeFileSync(join(dir, `${label}.png`), image.toPNG());
    const text = (await webContents.executeJavaScript("document.body.innerText")) as string;
    report[label] = { textLength: text.length, text: text.slice(0, 400), size: image.getSize() };
  };
  await shoot("sidebar", "sidebar");
  await shoot("tabs", "tabs");
  showTab("board");
  await wait(500);
  await shoot("board", "board");
  // Click the real Map tab, so the tab bar's own path to the app is covered.
  await views.tabs.webContents.executeJavaScript("document.querySelectorAll('#bar button')[1].click()");
  await wait(2500);
  report.mapTabOpened = views.map.getVisible() && !views.board.getVisible();
  await shoot("tabs-map", "tabs");
  await shoot("map", "map");
  showTab("skills");
  await wait(500);
  await shoot("skills", "skills");
  showTab("git");
  await wait(3000);
  await shoot("git", "git");
  // A real terminal: open a shell from the screen's own button, type into it, and read it back.
  showTab("terminal");
  await wait(1000);
  await views.terminal.webContents.executeJavaScript("document.querySelector('[data-kind=\"shell\"]').click()");
  await wait(2500);
  const id = terminals.firstId();
  if (id !== undefined) terminals.input(id, "echo smoke-terminal-ok\r");
  await wait(2000);
  await shoot("terminal", "terminal");
  report.terminalWorked = String((report.terminal as { text: string }).text).includes("smoke-terminal-ok");
  const splitter = await dragSplitter(views);
  report.splitter = splitter;
  report.splitterWorked = Math.abs(splitter.after - splitter.before - 120) <= 2 && Math.abs(splitter.restored - splitter.before) <= 2;
  await shootSizes(views, showTab, shoot);
  terminals.closeAll();
  report.problems = problems;
  writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2));
  quit();
}
