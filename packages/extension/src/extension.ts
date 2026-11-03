import { randomBytes } from "node:crypto";
import { defaultCredentialsFile } from "hacky-mcp-server/credentials";
import * as vscode from "vscode";
import { confirmationUrl, HackyApi } from "./api.js";
import { SidebarController, type Message } from "./controller.js";

declare const __SUPABASE_URL__: string;
declare const __SUPABASE_PUBLISHABLE_KEY__: string;

const TEAM_KEY = "hacky.teamId";
const DIGEST_KEY = "hacky.digestAt";

// Owns the one controller. The sidebar and the map tab both show its state, so it runs while
// either is open and stops when both are closed.
class HackyUi {
  private controller: SidebarController | undefined;
  private readonly webviews = new Set<vscode.Webview>();
  private mapPanel: vscode.WebviewPanel | undefined;
  private boardPanel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly api: HackyApi,
  ) {}

  private createController(): SidebarController {
    return new SidebarController({
      api: this.api,
      supabaseUrl: __SUPABASE_URL__,
      publishableKey: __SUPABASE_PUBLISHABLE_KEY__,
      workspaceDir: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
      loadTeamId: () => this.context.workspaceState.get<string>(TEAM_KEY),
      saveTeamId: (teamId) => void this.context.workspaceState.update(TEAM_KEY, teamId),
      post: (state) => this.webviews.forEach((webview) => void webview.postMessage(state)),
      digestMinutes: () => vscode.workspace.getConfiguration("hacky").get<number>("progressDigestMinutes", 30),
      loadDigestAt: () => this.context.workspaceState.get<number>(DIGEST_KEY),
      saveDigestAt: (at) => void this.context.workspaceState.update(DIGEST_KEY, at),
      notify: (message) => {
        void vscode.window.showInformationMessage(message, "Open Hacky").then((choice) => {
          if (choice) void vscode.commands.executeCommand("hacky.sidebar.focus");
        });
      },
      openMap: () => this.openMap(),
      openBoard: () => this.openBoard(),
    });
  }

  // Shows the controller's state in a webview and passes its messages on. Dispose when the webview goes.
  attach(webview: vscode.Webview): vscode.Disposable {
    this.webviews.add(webview);
    const controller = (this.controller ??= this.createController());
    const subscription = webview.onDidReceiveMessage((message: Message) => void controller.handle(message));
    return {
      dispose: () => {
        subscription.dispose();
        this.webviews.delete(webview);
        if (this.webviews.size === 0) {
          this.controller?.dispose();
          this.controller = undefined;
        }
      },
    };
  }

  openMap(): void {
    if (this.mapPanel) {
      this.mapPanel.reveal();
      return;
    }
    const mediaUri = vscode.Uri.joinPath(this.context.extensionUri, "media");
    const panel = vscode.window.createWebviewPanel("hacky.map", "Hacky Map", vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [mediaUri],
      // Keeps the animation where it was when the tab is in the background.
      retainContextWhenHidden: true,
    });
    panel.webview.html = this.html(panel.webview, mediaUri, "map");
    const attachment = this.attach(panel.webview);
    this.mapPanel = panel;
    panel.onDidDispose(() => {
      attachment.dispose();
      this.mapPanel = undefined;
    });
  }

  openBoard(): void {
    if (this.boardPanel) {
      this.boardPanel.reveal();
      return;
    }
    const mediaUri = vscode.Uri.joinPath(this.context.extensionUri, "media");
    const panel = vscode.window.createWebviewPanel("hacky.board", "Hacky Board", vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [mediaUri],
      retainContextWhenHidden: true,
    });
    panel.webview.html = this.html(panel.webview, mediaUri, "board");
    const attachment = this.attach(panel.webview);
    this.boardPanel = panel;
    panel.onDidDispose(() => {
      attachment.dispose();
      this.boardPanel = undefined;
    });
  }

  html(webview: vscode.Webview, mediaUri: vscode.Uri, name: "sidebar" | "map" | "board"): string {
    const nonce = randomBytes(16).toString("hex");
    const uri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, file)).toString();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${uri(`${name}.css`)}" rel="stylesheet">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${uri(`${name}.js`)}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.mapPanel?.dispose();
    this.boardPanel?.dispose();
    this.controller?.dispose();
    this.controller = undefined;
  }
}

class SidebarProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly ui: HackyUi,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const mediaUri = vscode.Uri.joinPath(this.context.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [mediaUri] };
    view.webview.html = this.ui.html(view.webview, mediaUri, "sidebar");
    const attachment = this.ui.attach(view.webview);
    view.onDidDispose(() => attachment.dispose());
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const api = new HackyApi(
    __SUPABASE_URL__,
    __SUPABASE_PUBLISHABLE_KEY__,
    defaultCredentialsFile(),
    confirmationUrl(vscode.env.uriScheme),
  );
  const ui = new HackyUi(context, api);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("hacky.sidebar", new SidebarProvider(context, ui)),
    vscode.commands.registerCommand("hacky.openMap", () => ui.openMap()),
    vscode.commands.registerCommand("hacky.openBoard", () => ui.openBoard()),
    // The link's fragment holds login tokens. They're deliberately ignored: the user logs in as usual.
    vscode.window.registerUriHandler({
      handleUri: () => {
        void vscode.commands.executeCommand("hacky.sidebar.focus");
        void vscode.window.showInformationMessage("Your email is confirmed. Log in to Hacky in the sidebar.");
      },
    }),
    { dispose: () => ui.dispose() },
    { dispose: () => void api.dispose() },
  );
}
