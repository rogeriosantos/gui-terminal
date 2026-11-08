import { contextBridge, ipcRenderer } from "electron";
import type { ShellKind, SshHost, TerminalApi } from "../shared/types.js";

const api: TerminalApi = {
  listShells: () => ipcRenderer.invoke("shells:list"),
  createSession: (shell: ShellKind, opts?: { host?: string; cwd?: string }) =>
    ipcRenderer.invoke("pty:create", shell, opts),
  write: (id, data) => ipcRenderer.invoke("pty:write", id, data),
  resize: (id, cols, rows) => ipcRenderer.invoke("pty:resize", id, cols, rows),
  kill: (id) => ipcRenderer.invoke("pty:kill", id),
  sshHosts: () => ipcRenderer.invoke("ssh:hosts"),
  appInfo: () => ipcRenderer.invoke("app:info"),
  clipboardReadText: () => ipcRenderer.invoke("clipboard:readText"),
  clipboardWriteText: (t) => ipcRenderer.invoke("clipboard:writeText", t),
  stateLoad: () => ipcRenderer.invoke("state:load"),
  stateSave: (state) => ipcRenderer.invoke("state:save", state),
  onPtyOutput: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, chunk: { id: number; data: string }) => cb(chunk);
    ipcRenderer.on("pty:data", listener);
    return () => ipcRenderer.removeListener("pty:data", listener);
  },
  onPtyExit: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, info: { id: number; exitCode: number }) => cb(info);
    ipcRenderer.on("pty:exit", listener);
    return () => ipcRenderer.removeListener("pty:exit", listener);
  },
  onMenuNewTab: (cb) => {
    ipcRenderer.on("menu:new-tab", () => cb());
  },
  onMenuCloseTab: (cb) => {
    ipcRenderer.on("menu:close-tab", () => cb());
  },
  onMenuSplitH: (cb) => {
    ipcRenderer.on("menu:split-h", () => cb());
  },
  onMenuSplitV: (cb) => {
    ipcRenderer.on("menu:split-v", () => cb());
  },
  onMenuEdit: (cb) => {
    ipcRenderer.on("menu:edit:copy", () => cb("copy"));
    ipcRenderer.on("menu:edit:paste", () => cb("paste"));
    ipcRenderer.on("menu:edit:selectAll", () => cb("selectAll"));
    ipcRenderer.on("menu:edit:clear", () => cb("clear"));
  },
  platform: process.platform,
  version: "",
};

contextBridge.exposeInMainWorld("terminal", api);

export type { TerminalApi, SshHost };
