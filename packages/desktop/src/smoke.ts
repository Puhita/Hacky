// A test run: starts the app against the real project, takes a picture of each screen and writes
// a report, then quits. Set HACKY_SMOKE_DIR to turn it on.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WebContentsView } from "electron";
import type { PageName, Tab } from "./host.js";

type Context = {
  dir: string;
  views: Record<PageName, WebContentsView>;
  showTab: (tab: Tab) => void;
  quit: () => void;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runSmoke({ dir, views, showTab, quit }: Context): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const problems: string[] = [];
  for (const name of Object.keys(views) as PageName[]) {
    views[name].webContents.on("console-message", (event) => {
      if (event.level === "error") problems.push(`${name}: ${event.message}`);
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
  report.problems = problems;
  writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2));
  quit();
}
