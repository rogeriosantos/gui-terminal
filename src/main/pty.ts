import os from "node:os";
import { EventEmitter } from "node:events";

type Pty = {
  id: number;
  process: import("node-pty").IPty;
};

/**
 * Owns every shell process. Runs in the Electron main process; the renderer
 * talks to it exclusively over IPC.
 */
export class PtyManager extends EventEmitter {
  /** Live PTYs (test/inspection hook). */
  ptys = new Map<number, Pty>();
  private nextId = 1;

  create(
    file: string,
    args: string[],
    opts: { title: string; cwd?: string; env?: Record<string, string> },
  ) {
    const pty = require("node-pty").spawn(file, args, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: opts.cwd || os.homedir(),
      env: opts.env || process.env,
    }) as import("node-pty").IPty;

    const id = this.nextId++;
    this.ptys.set(id, { id, process: pty });

    pty.onData((data) => this.emit("data", id, data));
    pty.onExit(({ exitCode }) => {
      this.ptys.delete(id);
      this.emit("exit", id, exitCode);
    });

    return { id, pid: pty.pid, title: opts.title };
  }

  write(id: number, data: string) {
    this.ptys.get(id)?.process.write(data);
  }

  resize(id: number, cols: number, rows: number) {
    try {
      this.ptys.get(id)?.process.resize(cols, rows);
    } catch {
      // pty already gone
    }
  }

  kill(id: number) {
    const pty = this.ptys.get(id);
    if (!pty) return;
    this.ptys.delete(id);
    try {
      pty.process.kill();
    } catch {
      // already dead
    }
  }

  killAll() {
    for (const id of [...this.ptys.keys()]) this.kill(id);
  }
}
