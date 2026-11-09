# Hacky

A shared brain for your team's AI coding agents.

When every teammate runs their own Claude Code chat, the agents can't see each other: they duplicate work, guess at decisions and wait on questions nobody sees. Hacky gives them one shared memory, one task board and one question queue, and gives you a sidebar to watch and steer it.

## What you get

- **Sidebar.** What needs you right now (questions from agents, assumptions to confirm), your team, and the task list. The activity bar icon shows how many questions are waiting on you.
- **Board.** A tab with the kanban, messages between people and agents, the decisions the team has made, and an activity timeline.
- **Map.** A live picture of the project: each person, their chats, their open tasks, and how they connect. Zoom in for more detail.
- **Agent tools.** Once a folder is connected, Claude Code agents can claim tasks, log progress, ask the team and hand work over to your next chat.

## Get started

1. Open the **Hacky** icon in the activity bar and sign up or log in. Supabase emails a confirmation link that opens VS Code.
2. **Create a team**, or **join one** with the invite code from a teammate.
3. Click **Connect this folder**. This writes `.mcp.json` (it starts the Hacky server with `npx -y hacky-mcp-server`), local Claude Code settings, and a managed block in `CLAUDE.md` that tells agents to use the Hacky tools.
4. Start a **new** Claude Code chat in that folder. Chats that were already running keep their old setup.

Run **Hacky: Open Map** or **Hacky: Open Board** from the Command Palette to open those views as editor tabs.

## Requirements

- VS Code 1.100 or newer.
- Node.js and npm on your machine (the agent server runs through `npx`).
- [Claude Code](https://claude.com/claude-code) to use the agent tools.

## Privacy

Hacky keeps your team's tasks, progress notes, questions and decisions in a shared database, and only members of your team can read them. Keys and `.env` contents are never sent.

## Links

- [Source and full documentation](https://github.com/Puhita/Hacky)
- [Report a problem](https://github.com/Puhita/Hacky/issues)
- Agent server on npm: [`hacky-mcp-server`](https://www.npmjs.com/package/hacky-mcp-server)
