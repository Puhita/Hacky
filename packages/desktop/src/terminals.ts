// Runs the terminals behind the Terminal screen. Each one is a real pseudo-terminal, so the tools
// inside behave exactly as in a normal terminal window: login, prompts and colours all work.
import { spawn, type IPty } from "@lydell/node-pty";
import { MAX_TERMINALS, TERMINAL_COMMAND, terminalEnv, type TerminalKind } from "./host.js";

type Session = { pty: IPty; kind: TerminalKind; folder: string };

export class Terminals {
  private readonly sessions = new Map<number, Session>();
  private nextId = 1;

  constructor(
    private readonly onData: (id: number, data: string) => void,
    private readonly onExit: (id: number, code: number) => void,
  ) {}

  open(kind: TerminalKind, folder: string): number {
    if (this.sessions.size >= MAX_TERMINALS) throw new Error(`Close a terminal first. Hacky keeps at most ${MAX_TERMINALS} open.`);
    const id = this.nextId++;
    const pty = spawn("powershell.exe", ["-NoLogo"], { name: "xterm-256color", cols: 100, rows: 30, cwd: folder, env: terminalEnv(process.env) });
    this.sessions.set(id, { pty, kind, folder });
    pty.onData((data) => this.onData(id, data));
    pty.onExit(({ exitCode }) => {
      this.sessions.delete(id);
      // Without this the finished terminal keeps its handles open, and the process can't end.
      try {
        pty.kill();
      } catch {
        // Already gone.
      }
      this.onExit(id, exitCode);
    });
    const command = TERMINAL_COMMAND[kind];
    // Give the shell a moment to start so the command isn't lost in its start-up output.
    if (command) setTimeout(() => this.sessions.has(id) && pty.write(`${command}\r`), 700);
    return id;
  }

  input(id: number, data: string): void {
    this.sessions.get(id)?.pty.write(data);
  }

  resize(id: number, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (session && cols > 0 && rows > 0) session.pty.resize(Math.min(cols, 500), Math.min(rows, 200));
  }

  close(id: number): void {
    const session = this.sessions.get(id);
    if (session) {
      this.sessions.delete(id);
      session.pty.kill();
    }
  }

  firstId(): number | undefined {
    return this.sessions.keys().next().value;
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}
