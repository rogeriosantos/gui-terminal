// Shared types between the Electron main process and the renderer.

export type ShellKind = "default" | "zsh" | "bash" | "sh" | "pwsh";

export interface PtyInfo {
  /** Unique id used in all IPC calls. */
  id: number;
  shell: ShellKind;
  title: string;
  /** Pid of the shell process (for tab titles / process inspection). */
  pid: number;
}

export interface PtyOutputChunk {
  id: number;
  data: string;
}

/** Invoked from the renderer; implemented in main. */
export interface TerminalApi {
  listShells(): Promise<{ kind: ShellKind; label: string; available: boolean }[]>;
  createSession(
    shell: ShellKind,
    opts?: { host?: string; cwd?: string },
  ): Promise<PtyInfo>;
  write(id: number, data: string): Promise<void>;
  resize(id: number, cols: number, rows: number): Promise<void>;
  kill(id: number): Promise<void>;
  sshHosts(): Promise<SshHost[]>;
  appInfo(): Promise<{ platform: NodeJS.Platform; version: string }>;
  onPtyOutput(cb: (chunk: PtyOutputChunk) => void): () => void;
  onPtyExit(cb: (info: { id: number; exitCode: number }) => void): () => void;
  onMenuNewTab(cb: () => void): void;
  onMenuCloseTab(cb: () => void): void;
  platform: NodeJS.Platform;
  version: string;
}

export interface SshHost {
  host: string;
  hostname?: string;
  user?: string;
}

declare global {
  interface Window {
    terminal: TerminalApi;
  }
}

export {};
