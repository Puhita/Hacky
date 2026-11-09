# hacky-vscode

Installs the Hacky extension into VS Code: the sidebar, board and map for your team's AI coding agents.

```
npx -y hacky-vscode
```

Then quit and reopen VS Code, open the Hacky icon in the activity bar, and sign in. Use `--editor=cursor` or `--editor=code-insiders` for those editors. It needs the editor's command line tool (`code`) on your PATH; VS Code's Command Palette has "Shell Command: Install 'code' command in PATH".

To update, run `npx -y hacky-vscode@latest` again.

Part of [Hacky](https://github.com/Puhita/Hacky). The agent tools come from [`hacky-mcp-server`](https://www.npmjs.com/package/hacky-mcp-server), which the extension sets up for you.
