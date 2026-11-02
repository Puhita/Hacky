import { randomBytes } from "node:crypto";
import { defaultCredentialsFile } from "hacky-mcp-server/credentials";
import * as vscode from "vscode";
import { HackyApi } from "./api.js";
import { SidebarController, type Message } from "./controller.js";

declare const __SUPABASE_URL__: string;
declare const __SUPABASE_PUBLISHABLE_KEY__: string;

const TEAM_KEY = "hacky.teamId";

class SidebarProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly api: HackyApi,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const mediaUri = vscode.Uri.joinPath(this.context.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [mediaUri] };
    view.webview.html = this.html(view.webview, mediaUri);

    const controller = new SidebarController({
      api: this.api,
      supabaseUrl: __SUPABASE_URL__,
      publishableKey: __SUPABASE_PUBLISHABLE_KEY__,
      workspaceDir: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
      loadTeamId: () => this.context.workspaceState.get<string>(TEAM_KEY),
      saveTeamId: (teamId) => void this.context.workspaceState.update(TEAM_KEY, teamId),
      post: (state) => void view.webview.postMessage(state),
    });
    view.webview.onDidReceiveMessage((message: Message) => void controller.handle(message));
    view.onDidDispose(() => controller.dispose());
  }

  private html(webview: vscode.Webview, mediaUri: vscode.Uri): string {
    const nonce = randomBytes(16).toString("hex");
    const uri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, file)).toString();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${uri("sidebar.css")}" rel="stylesheet">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${uri("sidebar.js")}"></script>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const api = new HackyApi(__SUPABASE_URL__, __SUPABASE_PUBLISHABLE_KEY__, defaultCredentialsFile());
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("hacky.sidebar", new SidebarProvider(context, api)),
    { dispose: () => void api.dispose() },
  );
}
