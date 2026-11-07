import { app, BrowserWindow, ipcMain, Menu, shell as electronShell } from "electron";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { PtyManager } from "./pty.js";

const ptyManager = new PtyManager();

let mainWindow: BrowserWindow | null = null;

function findBin(name: string): string | null {
  const paths = (process.env.PATH || "").split(path.delimiter);
  for (const dir of paths) {
    const full = path.join(dir, name);
    if (existsSync(full)) return full;
  }
  return null;
}

export function detectShells() {
  const platform = os.platform();
  const candidates: { kind: string; label: string; file: string | null }[] = [];

  if (platform === "win32") {
    candidates.push(
      { kind: "pwsh", label: "PowerShell", file: findBin("pwsh.exe") ?? findBin("powershell.exe") },
      { kind: "cmd", label: "Command Prompt", file: findBin("cmd.exe") },
      { kind: "bash", label: "Git Bash", file: findBin("bash.exe") },
    );
  } else {
    candidates.push(
      { kind: "zsh", label: "zsh", file: findBin("zsh") ?? "/bin/zsh" },
      { kind: "bash", label: "bash", file: findBin("bash") ?? "/bin/bash" },
      { kind: "sh", label: "sh", file: "/bin/sh" },
    );
  }

  return candidates
    .filter((c) => c.file !== null)
    .map((c) => ({ kind: c.kind, label: c.label, file: c.file as string }));
}

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 640,
    minHeight: 420,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: "#0c0e14",
    show: false,
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(app.getAppPath(), "dist", "index.html"));
  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    electronShell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow = win;

  // Dev facility: GT_SCREENSHOT=/path.png captures the window shortly after load.
  if (process.env.GT_SCREENSHOT) {
    const file = process.env.GT_SCREENSHOT;
    setTimeout(async () => {
      try {
        const img = await win.webContents.capturePage();
        require("node:fs").writeFileSync(file, img.toPNG());
        console.log(`screenshot written: ${file}`);
      } catch (e) {
        console.error("screenshot failed", e);
      }
    }, 4000);
  }

  // Dev/test facility: GT_VERIFY=1 exercises the full PTY -> xterm loop.
  if (process.env.GT_VERIFY) {
    setTimeout(async () => {
      try {
        const before = await win.webContents.executeJavaScript(
          `document.querySelector('.xterm-rows')?.innerText.slice(0, 200) ?? 'NO-XTERM'`,
        );
        // Type a command through the manager (same path as the keyboard).
        const first = [...ptyManager.ptys?.keys?.() ?? []][0];
        if (first !== undefined) ptyManager.write(first, "echo GT_VERIFY_OK_$((20+3))\n");
        await new Promise((r) => setTimeout(r, 1500));
        const after = await win.webContents.executeJavaScript(
          `document.querySelector('.xterm-rows')?.innerText.slice(0, 400) ?? 'NO-XTERM'`,
        );
        console.log("GT_VERIFY before:", JSON.stringify(before));
        console.log("GT_VERIFY after:", JSON.stringify(after));
        app.quit();
      } catch (e) {
        console.error("GT_VERIFY failed", e);
        app.exit(1);
      }
    }, 6000);
  }
  return win;
};

app.whenReady().then(() => {
  createWindow();

  const isMac = os.platform() === "darwin";
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        { label: "New Tab", accelerator: "CmdOrCtrl+T", click: () => mainWindow?.webContents.send("menu:new-tab") },
        { label: "Close Tab", accelerator: "CmdOrCtrl+W", click: () => mainWindow?.webContents.send("menu:close-tab") },
        { type: "separator" },
        isMac ? { role: "close", label: "Close Window" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
        { role: "zoomIn", label: "Bigger Font" },
        { role: "zoomOut", label: "Smaller Font" },
        { role: "resetZoom", label: "Reset Font" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (os.platform() !== "darwin") app.quit();
});

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle("shells:list", () =>
  detectShells().map(({ kind, label }) => ({ kind, label, available: true })),
);

ipcMain.handle("pty:create", (_e, shellKind: string, opts?: { host?: string; cwd?: string }) => {
  const shells = detectShells();
  let file: string;
  let args: string[] = [];
  let title = "";

  if (opts?.host) {
    // SSH tab: launch the system ssh client so keys, agents and ProxyJump work.
    file = "/usr/bin/ssh";
    if (!existsSync(file)) file = findBin("ssh") ?? "ssh";
    args = ["-t", opts.host]; // always allocate a TTY
    title = opts.host;
  } else if (shellKind === "default" || !shellKind) {
    const def =
      shells.find((s) => s.kind === process.env.SHELL?.split("/").pop()) ?? shells[0];
    file = def.file;
    title = def.label;
  } else {
    const found = shells.find((s) =>s.kind === shellKind);
    if (!found) throw new Error(`Shell not found: ${shellKind}`);
    file = found.file;
    title = found.label;
  }

  return ptyManager.create(file, args, {
    title,
    cwd: opts?.cwd,
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
  });
});

ipcMain.handle("pty:write", (_e, id: number, data: string) => ptyManager.write(id, data));
ipcMain.handle("pty:resize", (_e, id: number, cols: number, rows: number) =>
  ptyManager.resize(id, cols, rows),
);
ipcMain.handle("pty:kill", (_e, id: number) => ptyManager.kill(id));

// Host completions from ~/.ssh/config (best effort).
ipcMain.handle("ssh:hosts", async () => {
  const configPath = path.join(os.homedir(), ".ssh", "config");
  const hosts: { host: string; hostname?: string; user?: string }[] = [];
  if (!existsSync(configPath)) return hosts;
  const content = await import("node:fs/promises").then((m) => m.readFile(configPath, "utf8"));
  let current: { host: string; hostname?: string; user?: string } | null = null;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const [key, ...rest] = line.split(/\s+/);
    const value = rest.join(" ");
    if (/^Host$/i.test(key)) {
      if (current && !/[*?!]/.test(current.host)) hosts.push(current);
      current = { host: value };
    } else if (current && /^HostName$/i.test(key)) current.hostname = value;
    else if (current && /^User$/i.test(key)) current.user = value;
  }
  if (current && !/[*?!]/.test(current.host)) hosts.push(current);
  // Dedupe: later Host blocks override earlier ones for the same alias.
  const seen = new Map<string, { host: string; hostname?: string; user?: string }>();
  for (const h of hosts) seen.set(h.host, { ...seen.get(h.host), ...h });
  return [...seen.values()];
});

// Child-process helpers for the GUI around the terminals.
ipcMain.handle("proc:run", async (_e, command: string, args: string[], timeoutMs = 10_000) => {
  return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(command, args, {
      env: { ...process.env, TERM: "dumb" },
      timeout: timeoutMs,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: String(err) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
});

ptyManager.on("data", (id, data) => mainWindow?.webContents.send("pty:data", { id, data }));
ptyManager.on("exit", (id, exitCode) => mainWindow?.webContents.send("pty:exit", { id, exitCode }));

// expose platform to renderer via handles
ipcMain.handle("app:info", () => ({ platform: os.platform(), version: app.getVersion() }));

// Clean shutdown: kill every live PTY so no shell is left running.
app.on("before-quit", () => ptyManager.killAll());
