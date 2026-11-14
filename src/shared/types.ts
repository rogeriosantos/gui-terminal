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

export interface SshHost {
  host: string;
  hostname?: string;
  user?: string;
}

/** What a restored tab needs to recreate itself. */
export interface SavedTab {
  kind: "local" | "ssh";
  shell: ShellKind;
  host?: string;
  paneCount: number;
  splitDir: "h" | "v";
}

export interface SavedState {
  version:  1;
  tabs: SavedTab[];
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
  clipboardReadText(): Promise<string>;
  clipboardWriteText(text: string): Promise<void>;
  stateLoad(): Promise<SavedState | null>;
  stateSave(state: SavedState): Promise<void>;
  onPtyOutput(cb: (chunk: PtyOutputChunk) => void): () => void;
  onPtyExit(cb: (info: { id: number; exitCode: number }) => void): () => void;
  onMenuNewTab(cb: () => void): void;
  onMenuCloseTab(cb: () => void): void;
  onMenuSplitH(cb: () => void): void;
  onMenuSplitV(cb: () => void): void;
  /** action: "copy" | "paste" | "selectAll" | "char" | "line" | "word" | "clear" */
  onMenuEdit(cb: (action: string) => void): void;
  onMenuSelectTab(cb: (index: number) => void): void;
  onMenuNextTab(cb: () => void): void;
  platform: NodeJS.Platform;
  version: string;
}

declare global {
  interface Window {
    terminal: TerminalApi;
  }
}

export {};
