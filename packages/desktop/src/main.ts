// Hacky for Windows. Runs the same controller as the VS Code extension and shows its state in
// one window: the sidebar on the left, the board and the map as tabs on the right.
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { defaultCredentialsFile } from "hacky-mcp-server/credentials";
import { app, BaseWindow, dialog, ipcMain, Menu, nativeImage, Notification, protocol, shell, Tray, WebContentsView } from "electron";
import { confirmationUrl, HackyApi } from "../../extension/src/api.js";
import { attentionCount, statusText } from "../../extension/src/attention.js";
import { folderStatus, SidebarController, type SidebarState } from "../../extension/src/controller.js";
import {
  addFolder,
  assetPath,
  collapsesAt,
  contentType,
  PAGE_NAMES,
  pageHtml,
  parseMessage,
  parseTerminalOpen,
  RAIL_WIDTH,
  removeFolder,
  sidebarWidth,
  SPLITTER_WIDTH,
  startsCollapsed,
  type PageName,
  type Tab,
} from "./host.js";
import { runSmoke } from "./smoke.js";
import { Terminals } from "./terminals.js";
import { installUpdateNow, startUpdates } from "./updater.js";

declare const __SUPABASE_URL__: string;
declare const __SUPABASE_PUBLISHABLE_KEY__: string;
declare const __GITHUB_CLIENT_ID__: string;

const TAB_BAR_HEIGHT = 40;
// A drag the screen stopped reporting (it lost the mouse some way we didn't hear about) ends by itself.
const DRAG_TIMEOUT_MS = 4000;
// Narrower than this, the sidebar hides by itself (see autoCollapse).
const AUTO_COLLAPSE_WIDTH = 600;
const smokeDir = process.env.HACKY_SMOKE_DIR;

// The app's own settings. The sign-in itself is in the shared credentials file.
// "folder" is the one the sidebar acts on; "folders" are all the connected project folders.
// "sidebarWidth" and "sidebarCollapsed" are how the person left the sidebar.
type Settings = { teamId?: string; digestAt?: number; folder?: string; folders?: string[]; sidebarWidth?: number; sidebarCollapsed?: boolean };
const settingsFile = () => join(app.getPath("userData"), "settings.json");
let settings: Settings = {};
function loadSettings(): void {
  try {
    settings = JSON.parse(readFileSync(settingsFile(), "utf8"));
  } catch {
    settings = {};
  }
  // Versions before 0.1.2 kept a single folder.
  if (settings.folder && !settings.folders?.includes(settings.folder)) settings.folders = addFolder(settings.folders ?? [], settings.folder);
}
function saveSettings(change: Partial<Settings>): void {
  settings = { ...settings, ...change };
  writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

if (smokeDir) {
  // A test run never touches the real app's settings, and can run beside it.
  app.setPath("userData", join(smokeDir, "user-data"));
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win: BaseWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
const views = {} as Record<PageName, WebContentsView>;
let api: HackyApi | undefined;
let controller: SidebarController | undefined;
let terminals: Terminals | undefined;

const distFile = (path: string) => join(__dirname, path);

function showWindow(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// The sidebar: shown at the width the person chose, or hidden behind a narrow rail of icons.
let sidebarCollapsed = false;
// While the splitter is being dragged: where the sidebar's edge is now, in window coordinates.
let dragX: number | undefined;
let dragTimer: NodeJS.Timeout | undefined;
let needsCount = 0;

function layout(): void {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  // Too narrow for the sidebar and a screen side by side: the shown sidebar takes the window,
  // next to the rail, whose buttons hide it again or go straight to a screen.
  if (!sidebarCollapsed && width < AUTO_COLLAPSE_WIDTH) {
    views.sidebar.setVisible(true);
    views.rail.setVisible(true);
    views.splitter.setVisible(false);
    views.rail.setBounds({ x: 0, y: 0, width: RAIL_WIDTH, height });
    views.sidebar.setBounds({ x: RAIL_WIDTH, y: 0, width: width - RAIL_WIDTH, height });
    const away = { x: width, y: 0, width: 0, height: 0 };
    for (const name of ["tabs", "board", "map", "skills", "git", "terminal"] as const) views[name].setBounds(away);
    return;
  }
  const side = sidebarCollapsed ? RAIL_WIDTH : sidebarWidth(width, dragX ?? settings.sidebarWidth);
  views.sidebar.setVisible(!sidebarCollapsed);
  views.rail.setVisible(sidebarCollapsed);
  views.splitter.setVisible(!sidebarCollapsed);
  views.sidebar.setBounds({ x: 0, y: 0, width: side, height });
  views.rail.setBounds({ x: 0, y: 0, width: RAIL_WIDTH, height });
  // While dragged, the splitter covers the whole window (it is see-through then), so the mouse
  // can't leave it however fast it moves; the rest of the time it is the thin strip at the edge.
  views.splitter.setBounds(dragX === undefined ? { x: side, y: 0, width: SPLITTER_WIDTH, height } : { x: 0, y: 0, width, height });
  const left = sidebarCollapsed ? side : side + SPLITTER_WIDTH;
  views.tabs.setBounds({ x: left, y: 0, width: width - left, height: TAB_BAR_HEIGHT });
  const content = { x: left, y: TAB_BAR_HEIGHT, width: width - left, height: height - TAB_BAR_HEIGHT };
  views.board.setBounds(content);
  views.map.setBounds(content);
  views.skills.setBounds(content);
  views.git.setBounds(content);
  views.terminal.setBounds(content);
}

// What the tab bar, the rail and the splitter show: the open tab, whether the sidebar is hidden,
// and how many things need the person.
function sendChrome(): void {
  const chrome = { activeTab, sidebarCollapsed, needs: needsCount, dragging: dragX !== undefined };
  for (const name of ["tabs", "rail", "splitter"] as const) views[name]?.webContents.send("hacky:state", chrome);
}

// A window too narrow for the sidebar and a screen side by side hides the sidebar by itself, and
// shows it again once the window is wide enough, unless the person hid or showed it in between.
let autoCollapsed = false;
let wasNarrow = false;
function autoCollapse(): boolean {
  if (!win) return false;
  const narrow = win.getContentBounds().width < AUTO_COLLAPSE_WIDTH;
  const before = sidebarCollapsed;
  if (narrow && !wasNarrow && !sidebarCollapsed) {
    sidebarCollapsed = true;
    autoCollapsed = true;
  } else if (!narrow && autoCollapsed) {
    sidebarCollapsed = false;
    autoCollapsed = false;
  }
  wasNarrow = narrow;
  return before !== sidebarCollapsed;
}

function setSidebarCollapsed(collapsed: boolean): void {
  endDrag(false);
  autoCollapsed = false;
  sidebarCollapsed = collapsed;
  saveSettings({ sidebarCollapsed: collapsed });
  layout();
  sendChrome();
}

function windowX(screenX: number): number {
  return win ? Math.round(screenX - win.getContentBounds().x) : screenX;
}

// Where in the handle the mouse went down, so the edge doesn't jump to the pointer.
let dragOffset = 0;

function startDrag(screenX: number): void {
  if (!win || sidebarCollapsed) return;
  dragOffset = windowX(screenX) - sidebarWidth(win.getContentBounds().width, settings.sidebarWidth);
  moveDrag(screenX);
}

function moveDrag(screenX: number): void {
  if (!win || sidebarCollapsed) return;
  dragX = windowX(screenX) - dragOffset;  clearTimeout(dragTimer);
  dragTimer = setTimeout(() => endDrag(true), DRAG_TIMEOUT_MS);
  layout();
}

// Ends a drag. Dropped far to the left, the sidebar hides; anywhere else it keeps that width.
function endDrag(keep: boolean, screenX?: number): void {
  clearTimeout(dragTimer);
  dragTimer = undefined;
  if (dragX === undefined) return;
  const x = screenX === undefined ? dragX : windowX(screenX) - dragOffset;
  dragX = undefined;
  if (keep && win) {
    if (collapsesAt(x)) {
      sidebarCollapsed = true;
      saveSettings({ sidebarCollapsed: true });
    } else {
      saveSettings({ sidebarWidth: sidebarWidth(win.getContentBounds().width, x) });
    }
  }
  layout();
  sendChrome();
}

function nudgeSidebar(by: number): void {
  if (!win || sidebarCollapsed) return;
  const width = win.getContentBounds().width;
  saveSettings({ sidebarWidth: sidebarWidth(width, sidebarWidth(width, settings.sidebarWidth) + by) });
  layout();
}

let activeTab: Tab = "board";
function showTab(tab: Tab): void {
  activeTab = tab;
  views.board.setVisible(tab === "board");
  views.map.setVisible(tab === "map");
  views.skills.setVisible(tab === "skills");
  views.git.setVisible(tab === "git");
  views.terminal.setVisible(tab === "terminal");
  sendChrome();
}

// Shows a screen the person asked for. In a narrow window the sidebar covers the screens, so it
// hides until the window is wide enough again.
function revealTab(tab: Tab): void {
  if (!sidebarCollapsed && win && win.getContentBounds().width < AUTO_COLLAPSE_WIDTH) {
    sidebarCollapsed = true;
    autoCollapsed = true;
    layout();
  }
  showTab(tab);
}

function showAttention(state: SidebarState): void {
  if (!tray) return;
  const count = state.user && state.team ? attentionCount(state) : 0;
  tray.setToolTip(state.user && state.team ? statusText(count) : "Hacky");
}

function createWindow(): void {
  win = new BaseWindow({ width: 1280, height: 820, minWidth: 360, minHeight: 400, title: "Hacky", icon: distFile("icon.png"), backgroundColor: "#1e1e1e" });
  sidebarCollapsed = startsCollapsed(win.getContentBounds().width, settings.sidebarCollapsed);
  autoCollapse();
  for (const name of PAGE_NAMES) {
    const view = new WebContentsView({
      // A test run keeps painting while its window is covered, or its screenshots wait forever for a frame.
      webPreferences: { preload: distFile("preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: !smokeDir },
    });
    // The splitter is see-through while dragged, so the screens show under it.
    view.setBackgroundColor(name === "splitter" ? "#00000000" : "#1e1e1e");
    // A screen never navigates away or opens windows of its own.
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.on("will-navigate", (event) => event.preventDefault());
    win.contentView.addChildView(view);
    views[name] = view;
    void view.webContents.loadURL(`app://ui/${name}.html`);
  }
  layout();
  showTab("board");
  win.on("resize", () => {
    if (autoCollapse()) sendChrome();
    layout();
  });
  // A drag never outlives the window losing focus.
  win.on("blur", () => endDrag(true));
  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    win?.hide();
  });
}

// The version waiting to be installed, once an update has downloaded.
let updateReady: string | undefined;

function trayMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: "Open Hacky", click: showWindow },
    ...(updateReady ? [{ label: `Restart to update to ${updateReady}`, click: installUpdateNow }] : []),
    { type: "separator" },
    { label: `Hacky ${app.getVersion()}`, enabled: false },
    { label: "Quit", click: () => app.quit() },
  ]);
}

function createTray(): void {
  tray = new Tray(nativeImage.createFromPath(distFile("icon.png")).resize({ width: 16, height: 16 }));
  tray.setToolTip("Hacky");
  tray.on("click", showWindow);
  tray.setContextMenu(trayMenu());
}

function onUpdateReady(version: string): void {
  updateReady = version;
  tray?.setContextMenu(trayMenu());
  new Notification({ title: "Hacky", body: `Hacky ${version} is ready. It installs when you quit, or restart now from the tray icon.` }).show();
}

function createController(): SidebarController {
  api = new HackyApi(__SUPABASE_URL__, __SUPABASE_PUBLISHABLE_KEY__, defaultCredentialsFile(), confirmationUrl("hacky"));
  return new SidebarController({
    api,
    // The person's own GitHub token stays in the app's folder on this computer.
    githubTokenFile: join(app.getPath("userData"), "github-token"),
    openExternal: (url) => void shell.openExternal(url),
    // Sign in with GitHub through the device flow. Empty when the build has no OAuth App client ID.
    githubClientId: __GITHUB_CLIENT_ID__ || undefined,
    supabaseUrl: __SUPABASE_URL__,
    publishableKey: __SUPABASE_PUBLISHABLE_KEY__,
    workspaceDir: () => settings.folder ?? null,
    loadTeamId: () => settings.teamId,
    saveTeamId: (teamId) => saveSettings({ teamId }),
    post: (state) => {
      // The screens also show the connected folders and how each one stands.
      const folders = (settings.folders ?? []).map((path) => ({
        path,
        name: basename(path),
        status: folderStatus(path, state.team?.id),
        active: path === settings.folder,
      }));
      const data = { ...state, folder: settings.folder ? basename(settings.folder) : null, folders };
      for (const name of ["sidebar", "board", "map", "skills", "git", "terminal"] as const) views[name].webContents.send("hacky:state", data);
      showAttention(state);
      needsCount = state.user && state.team ? attentionCount(state) : 0;
      sendChrome();
    },
    digestMinutes: () => 30,
    loadDigestAt: () => settings.digestAt,
    saveDigestAt: (at) => saveSettings({ digestAt: at }),
    notify: (message) => {
      const notification = new Notification({ title: "Hacky", body: message });
      notification.on("click", showWindow);
      notification.show();
    },
    openMap: () => {
      revealTab("map");
      showWindow();
    },
    openBoard: () => {
      revealTab("board");
      showWindow();
    },
    openSkills: () => {
      revealTab("skills");
      showWindow();
    },
    openGit: () => {
      revealTab("git");
      showWindow();
    },
  });
}

async function chooseFolder(): Promise<void> {
  const result = await dialog.showOpenDialog({ title: "Choose the project folder to connect", properties: ["openDirectory"] });
  if (result.canceled || !result.filePaths[0]) return;
  saveSettings({ folder: result.filePaths[0], folders: addFolder(settings.folders ?? [], result.filePaths[0]) });
  await controller?.refresh();
}

// Acts only on folders the person has already added.
async function connectFolder(path: string, editors: unknown): Promise<void> {
  if (!settings.folders?.includes(path)) return;
  saveSettings({ folder: path });
  const chosen = Array.isArray(editors) ? editors : undefined;
  await controller?.handle({ type: "connectWorkspace", editors: chosen });
}

async function dropFolder(path: string): Promise<void> {
  if (!settings.folders?.includes(path)) return;
  const folders = removeFolder(settings.folders, path);
  saveSettings({ folders, folder: settings.folder === path ? folders[0] : settings.folder });
  await controller?.refresh();
}

function handleMessage(raw: unknown): void {
  const parsed = parseMessage(raw);
  if (!parsed) return;
  if (parsed.kind === "showTab") revealTab(parsed.tab);
  else if (parsed.kind === "chooseFolder") void chooseFolder();
  else if (parsed.kind === "connectFolder") void connectFolder(parsed.path, parsed.editors);
  else if (parsed.kind === "removeFolder") void dropFolder(parsed.path);
  else if (parsed.kind === "setSidebarCollapsed") setSidebarCollapsed(parsed.collapsed);
  else if (parsed.kind === "sidebarNudge") nudgeSidebar(parsed.by);
  else if (parsed.kind === "sidebarDrag") {
    if (parsed.phase === "start") startDrag(parsed.screenX);
    else if (parsed.phase === "move") moveDrag(parsed.screenX);
    else endDrag(true, parsed.screenX);
  } else {
    // A screen that has just loaded missed which tab is showing.
    if (parsed.message.type === "ready") sendChrome();
    void controller?.handle(parsed.message);
  }
}

// The email confirmation link (hacky://...) brings the person back to the app. Its fragment holds
// login tokens, which are deliberately ignored: they log in as usual.
function handleConfirmationLink(): void {
  showWindow();
  new Notification({ title: "Hacky", body: "Your email is confirmed. Log in to Hacky." }).show();
}
const linkIn = (argv: string[]) => argv.some((arg) => arg.startsWith("hacky://"));

app.on("second-instance", (_event, argv) => {
  if (linkIn(argv)) handleConfirmationLink();
  else showWindow();
});
app.on("before-quit", () => {
  quitting = true;
  terminals?.closeAll();
});
app.on("will-quit", () => {
  controller?.dispose();
  void api?.dispose();
});
app.on("window-all-closed", () => app.quit());

void app.whenReady().then(() => {
  loadSettings();
  if (app.isPackaged) app.setAsDefaultProtocolClient("hacky");

  protocol.handle("app", (request) => {
    const { pathname } = new URL(request.url);
    const page = PAGE_NAMES.find((name) => pathname === `/${name}.html`);
    if (page) return new Response(pageHtml(page), { headers: { "content-type": "text/html; charset=utf-8" } });
    const file = assetPath(pathname);
    if (!file) return new Response("Not found", { status: 404 });
    try {
      return new Response(readFileSync(distFile(file)), { headers: { "content-type": contentType(file) } });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });

  ipcMain.on("hacky:message", (event, raw) => {
    if (!event.senderFrame?.url.startsWith("app://ui/")) return;
    handleMessage(raw);
  });

  // Terminals. Only the Terminal screen itself may use these: the other screens show text from
  // teammates and from GitHub, and must never be able to start a process.
  const fromTerminal = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) =>
    event.sender === views.terminal?.webContents && event.senderFrame?.url === "app://ui/terminal.html";
  const sendToTerminal = (channel: string, payload: unknown) => views.terminal.webContents.send(channel, payload);
  terminals = new Terminals(
    (id, data) => sendToTerminal("hacky:term:data", { id, data }),
    (id, code) => sendToTerminal("hacky:term:exit", { id, code }),
  );
  const idOf = (raw: unknown) => (typeof raw === "object" && raw !== null && Number.isInteger((raw as { id?: unknown }).id) ? (raw as { id: number }).id : null);
  ipcMain.handle("hacky:term:open", (event, raw) => {
    if (!fromTerminal(event)) return { error: "Not allowed." };
    const request = parseTerminalOpen(raw, settings.folders ?? []);
    if (!request) return { error: "Choose one of your project folders." };
    try {
      return terminals!.open(request.kind, request.folder);
    } catch (error) {
      return { error: (error as Error).message };
    }
  });
  ipcMain.on("hacky:term:input", (event, raw) => {
    const id = idOf(raw);
    const data = (raw as { data?: unknown } | null)?.data;
    if (fromTerminal(event) && id !== null && typeof data === "string" && data.length <= 65536) terminals!.input(id, data);
  });
  ipcMain.on("hacky:term:resize", (event, raw) => {
    const id = idOf(raw);
    const { cols, rows } = (raw ?? {}) as { cols?: unknown; rows?: unknown };
    if (fromTerminal(event) && id !== null && Number.isInteger(cols) && Number.isInteger(rows)) terminals!.resize(id, cols as number, rows as number);
  });
  ipcMain.on("hacky:term:close", (event, raw) => {
    const id = idOf(raw);
    if (fromTerminal(event) && id !== null) terminals!.close(id);
  });

  createWindow();
  createTray();
  controller = createController();
  if (linkIn(process.argv)) handleConfirmationLink();
  // Only an installed app updates itself; a test run never does.
  if (app.isPackaged && !smokeDir) startUpdates(onUpdateReady);
  if (smokeDir) {
    // A test run has no folders of its own; let the terminal test use the test folder.
    if (!settings.folders?.length) settings = { ...settings, folders: [smokeDir], folder: smokeDir };
    void runSmoke({ dir: smokeDir, views, showTab, terminals: terminals!, quit: () => app.quit() });
  }
});
