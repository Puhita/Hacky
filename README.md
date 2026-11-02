# Hacky

**A shared brain for your team's AI coding agents. Built for hackathons.**

Hacky is a VS Code extension plus a small MCP server that gives every teammate's AI agent (Claude Code first) one shared memory, task board, and question queue. When an agent is blocked on a decision, the question is asked **once**, answered **once**, and the answer reaches **every** agent that needs it.

> Status: early planning / pre-MVP.

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
| `check_answers(wait_seconds?)` | Answers and retractions for questions this agent is waiting on, optionally holding the call open until one arrives |

MCP servers cannot wake an idle agent, and polling between steps isn't enough: in testing, agents gave up within seconds, long before a human could reply. So an agent whose work depends on the answer calls `check_answers` with `wait_seconds`, which holds the call open on the server until an answer arrives or the time runs out. Waiting uses no tokens, but the agent can't do anything else meanwhile. If the work doesn't depend on the answer, the agent proceeds on its declared assumption and checks between steps.

### Data model

- `teams`, `members`
- `tasks` (owner, status, files)
- `events` (auto-journal)
- `decisions` (text, decided_by, status active/superseded, embedding)
- `questions` (text, context, routed_to, status, embedding)
- `question_waiters` (who is blocked on what)
- `assumptions` (pending / confirmed / rejected)

### Extension UI

- **Setup:** log in, create or join a team with an invite code. One click writes `.mcp.json` and a managed block in `CLAUDE.md`.
- **Inbox:** open questions, how many agents are waiting, context, one-click answer.
- **Task board** and **live feed**.
- **Assumptions** panel to confirm or reject.

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

## Success metric

Minutes per hackathon lost to coordination (copy-pasting, duplicate work, conflicting assumptions). If this isn't clearly reduced, Hacky has failed.

## License

TBD
