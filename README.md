# Hacky

**A shared brain for your team's AI coding agents. Built for hackathons.**

Hacky is a VS Code extension plus a small MCP server that gives every teammate's AI agent (Claude Code first) one shared memory, task board, and question queue. When an agent is blocked on a decision, the question is asked **once**, answered **once**, and the answer reaches **every** agent that needs it.

> Status: MVP built and being tested. `hacky-mcp-server` is on npm; the extension is installed from a `.vsix` and isn't on the Marketplace yet. Not yet used at a real hackathon.

## The problem

On a hackathon team, everyone runs their own agent. Each agent only knows its own session. Even with `CLAUDE.md`, `plan.md`, `README` task splits and per-person `journal.md` files, the same failure keeps happening:

- Three agents hit the same open question that only a human can answer.
- Each agent asks its own human.
- The humans copy-paste questions and answers between each other.
- Time is lost, and agents still end up acting on conflicting information.

Markdown files record what *already happened*. Nothing handles a **live, unresolved question**.

## What Hacky does

| Today | With Hacky |
|---|---|
| `plan.md` / README task split | Shared task board with owners and status |
| `journal.md` per person | Auto-written event log from agents |
| Copy-pasting questions and answers | Question queue with dedupe and routing |
| Old answers lost in chat history | Searchable decision log |

### Core features

1. **Shared context.** Agents call `get_context` at session start and see their tasks, active decisions, and what teammates did recently.
2. **Auto-journal.** Agents call `log_progress` when they finish a chunk of work. No more hand-maintained journals.
3. **Task claiming.** `claim_task` prevents duplicate work and warns about overlapping files.
4. **Decision broker.**
   - Agents search existing decisions before asking.
   - New questions are compared against open and answered ones (semantic match), and the asking agent decides whether a similar one is really the same. Three agents asking the same thing become one question with three waiters.
   - Questions are routed to the right human by task and file ownership.
   - One answer is saved as a decision and fanned out to all waiting agents.
5. **Assumptions.** A blocked agent can declare an assumption and keep working. Humans confirm or reject it later. A rejection or changed decision notifies every agent that relied on it.
6. **Several chats per account.** Every agent chat is its own session. Answers and notices are delivered to each chat separately, so one chat can't take what another was waiting for. A chat leaves a focus and handoff notes, and the person's next chat sees them in `get_context` and takes the work over with `resume_session`, including its open questions.
7. **Progress updates.** Agents log progress with what they'll do next, and are reminded when they go quiet. Teammates see it live in the sidebar's team pulse, and the extension shows a digest of what teammates got done every 30 minutes (`hacky.progressDigestMinutes`, 0 turns it off).
8. **Questions between agents.** When your task depends on work a teammate owns, your agent calls `ask_teammate`. The teammate's agent sees it on its next Hacky call, answers with `answer_teammate`, and the answer reaches your agent through `check_answers`. The teammate can also answer from the sidebar when none of their agents is running. These are not team decisions: only the two people see them.

## How it works

```
Agent (Claude Code, ...)  <--stdio-->  Local MCP server (bundled in extension)
                                                |
VS Code extension (sidebar UI) ---------------> Supabase (Postgres + Realtime + Auth)
```

- The MCP server runs **locally inside the extension**, so there is nothing to host.
- **Supabase free tier** provides Postgres, Realtime, Auth, Row Level Security (team isolation), and pgvector (semantic search). Embeddings use Supabase's built-in `gte-small` model via an Edge Function.
- Free Supabase projects pause after 7 days of inactivity. Irrelevant for a hackathon; add a daily ping if you need it always on.

### MCP tools

| Tool | Purpose |
|---|---|
| `get_context()` | My tasks, active decisions, recent teammate activity |
| `log_progress(summary, files)` | Record finished work |
| `claim_task(task_id)` | Take a task, detect file overlap |
| `create_task(title, files?)` | Add a task to the team board |
| `complete_task(task_id)` | Mark a task you own as done |
| `search_decisions(query)` | Check for an existing answer before asking |
| `ask(question, context, assumption?, task_id?, files?, confirmed_new?)` | Route the question and return a pending question id, or return similar questions for the agent to judge |
| `join_question(question_id, assumption?)` | Wait on a teammate's identical question, or get its answer if it has one |
| `check_answers(wait_seconds?)` | Answers for questions this agent is waiting on, notices of rejected assumptions and changed decisions, teammates' answers and questions for this agent, optionally holding the call open until one arrives |
| `save_handoff(notes)` | Notes for whoever continues this chat's work |
| `resume_session(session_id, takeover?)` | Take over the person's earlier chat: its waits, notices and notes. Refused while that chat looks active, unless the person confirms |
| `ask_teammate(question, context, to? / task_id? / files?)` | Ask a teammate's agent directly, routed by name or by who owns the task or files |
| `answer_teammate(question_id, answer)` | Answer a teammate agent's question. The first answer wins |

`log_progress` also takes `next` and `task_id`. Anything that needs the agent's attention, such as a waiting teammate question or a long silence since the last `log_progress`, rides along on the next tool result as `heads_up`, because an MCP server can't wake an idle agent.

MCP servers cannot wake an idle agent, and polling between steps isn't enough: in testing, agents gave up within seconds, long before a human could reply. So an agent whose work depends on the answer calls `check_answers` with `wait_seconds`, which holds the call open on the server until an answer arrives or the time runs out. Waiting uses no tokens, but the agent can't do anything else meanwhile. If the work doesn't depend on the answer, the agent proceeds on its declared assumption and checks between steps.

Each chat is a session, and a session is one MCP server process. A chat counts as active for 10 minutes after its last Hacky call, and `resume_session` refuses an active chat unless the person confirms it has stopped. Closing a chat marks it ended when the editor closes the server's stdin. If the process is killed instead, the chat just goes idle after those 10 minutes.

A rejected assumption notifies the agent that declared it and every other agent on the same question. A changed or withdrawn decision notifies the whole team, because every agent can read decisions, so there's no record of who relied on one. An agent that has already finished sees a notice only when its next session starts, so work it finished stays wrong until then.

### Data model

- `teams`, `members`
- `tasks` (owner, status, files)
- `events` (auto-journal)
- `decisions` (text, decided_by, status active/superseded, embedding)
- `questions` (text, context, routed_to, status, embedding)
- `agent_sessions` (one per chat: focus, handoff notes, last seen, who took it over)
- `question_waiters` (which chat is blocked on what)
- `peer_questions` (a question from one agent to a teammate, and its answer)
- `assumptions` (pending / confirmed / rejected)
- `notices` (news of a rejected assumption or changed decision, one per person) and `notice_deliveries` (which chat has been given which)

### Extension UI

- **Setup:** log in, create or join a team with an invite code. One click writes `.mcp.json` and a managed block in `CLAUDE.md`.
- **Inbox:** open questions, how many agents are waiting, context, one-click answer.
- **Agent questions:** questions between agents that involve you. Ones sent to you can be answered here.
- **Team pulse:** who has chats running, what each is doing, and the progress logged in the last hour. A notification shows what teammates got done at the chosen cadence, and when a teammate's agent asks you something.
- **Task board** and **live feed**.
- **Assumptions** panel to confirm or reject. Confirming answers the question with that assumption.
- **Decisions** list to replace or withdraw an answer. Withdrawing puts its question back in the inbox.

`CLAUDE.md` is not eliminated: it keeps a short, extension-managed block that tells agents to use the Hacky tools instead of asking their own human.

## Roadmap

1. **MVP (days 1–3)**
   - Supabase schema, RLS, auth
   - MCP server: `get_context`, `log_progress`, `ask`, `check_answers`
   - Sidebar inbox and feed; setup command
   - Embedding dedupe, routing, assumptions, retraction
2. **Dogfood** at the next hackathon and measure time lost to coordination.
3. **Later:** Cursor/Copilot support, smarter routing, always-on hosting.

## Known risks

1. **Agent compliance.** Agents may ignore the tools. Test this first, using strong `CLAUDE.md` wording and Claude Code hooks (e.g. SessionStart calling `get_context`).
2. **Dedupe false positives.** Merging two different questions sends the wrong answer to an agent. Prefer a duplicate question over a wrong merge. Similarity scores alone can't prevent this: in testing, "minimum password length" and "maximum password length" scored higher than most true paraphrases, so the asking agent makes the call.
3. **Routing accuracy.** Wrong routing turns the inbox into spam. Route by explicit task owner, fall back to the team lead.
4. **Bad answers broadcast.** One wrong answer reaches many agents. Show who will act on it and support retraction.
5. **Secrets.** Never store keys or `.env` contents; filter before writing to the shared DB.
6. **Chats and teammate questions.** An agent only sees a teammate's question on its next Hacky call, so the sidebar notification is the fallback for the human. A chat whose process is killed looks idle only after 10 minutes. The digest runs only once the sidebar has been opened in the session.

## Install

For a teammate joining a team that already exists:

1. **Install the extension.** Run `npx -y hacky-vscode` (use `--editor=cursor` for Cursor), then quit and reopen VS Code. It needs the `code` command on your PATH. To build the extension yourself, `npm run package` in `packages/extension` makes a `.vsix` for "Extensions: Install from VSIX...".
2. **Open the Hacky sidebar and log in.** Sign up first if you're new; Supabase emails a confirmation link that opens VS Code.
3. **Create a team, or join one** with the invite code from a teammate.
4. **Click "Connect this folder".** This writes `.mcp.json` (which starts the server with `npx -y hacky-mcp-server`), the local Claude Code settings, and the managed block in `CLAUDE.md` that tells agents to use the Hacky tools.
5. **Start a new Claude Code chat** in the folder. Chats that were already running keep their old server.

### Without VS Code: the Windows app

For people who work in another tool (Unity, Blender, Cursor...), the app shows the same sidebar, board and map in its own window and sits in the tray. Download `Hacky-Setup-<version>.exe` from [Releases](https://github.com/Puhita/Hacky/releases) and run it. It isn't code-signed yet, so Windows SmartScreen asks first: choose "More info", then "Run anyway". Log in, pick your team, then click "Choose folder" to add your project folders (you can add several). Tick the tools you use, Claude Code, Cursor or Codex, and click Connect: that writes `.mcp.json` for Claude Code, `.cursor/mcp.json` plus a rules file for Cursor, or `.codex/config.toml` plus `AGENTS.md` for Codex (Codex only reads project config in folders you've marked as trusted). The app updates itself from new releases. It shares its login with the extension, so you can use both.

To release a new version: bump `version` in `packages/desktop/package.json`, commit, then push a matching tag (`git tag v0.1.1 && git push origin v0.1.1`). The "Desktop release" workflow builds the installer and uploads it to a draft release. Check the draft, then publish it; installed apps pick it up within six hours or on their next start. The workflow needs the repository variables `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` (Settings → Secrets and variables → Actions → Variables). Never add the secret key there.

Whoever owns the Supabase project applies the migrations with `npx supabase db push` (needs the `.env` with the project ref and database password). The extension and server only need Node and npm on each teammate's machine.

## Success metric

Minutes per hackathon lost to coordination (copy-pasting, duplicate work, conflicting assumptions). If this isn't clearly reduced, Hacky has failed.

## License

[MIT](LICENSE)
