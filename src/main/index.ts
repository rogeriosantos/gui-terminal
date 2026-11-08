import { app, BrowserWindow, clipboard, ipcMain, Menu, shell as electronShell } from "electron";
import fs from "node:fs/promises";
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

  // Dev/test facility: GT_VERIFY=1 exercises PTY, splits, copy and paste.
  if (process.env.GT_VERIFY) {
    setTimeout(async () => {
      try {
        const q = (expr: string) => win.webContents.executeJavaScript(expr);
        const readBuf = () => q("document.querySelector('.xterm-rows')?.innerText ?? 'NO-XTERM'");
        const results: string[] = [];

        // 1. PTY loop
        const first = [...ptyManager.ptys.keys()][0];
        if (first === undefined) throw new Error("no pty");
        ptyManager.write(first, "echo LOOP_$((20+3))\n");
        await new Promise((r) => setTimeout(r, 1200));
        results.push("pty-loop: " + ((await readBuf()).includes("LOOP_23") ? "PASS" : "FAIL"));

        // 2. Split via the real menu channel
        win.webContents.send("menu:split-h");
        await new Promise((r) => setTimeout(r, 800));
        const frames = await q("document.querySelectorAll('.pane-frame').length");
        results.push("split: " + (frames === 2 ? "PASS (2 panes)" : "FAIL (" + frames + ")"));

        // 3. Paste: clipboard -> focused pane's PTY
        const { clipboard } = await import("electron");
        clipboard.writeText("PASTE_MARKER_42");
        win.webContents.send("menu:edit:paste");
        await new Promise((r) => setTimeout(r, 800));
        const allText = await q(
          "Array.from(document.querySelectorAll('.xterm-rows')).map(e => e.innerText).join('\\n')",
        );
        results.push("paste: " + (allText.includes("PASTE_MARKER_42") ? "PASS" : "FAIL"));

        // 4. Copy probe: select-all + copy, then paste into the same shell and
        //    verify the shell echoes the copied text back (full round trip).
        const selLen = await q(
          "(() => { const h = window.__GT_PANES && [...window.__GT_PANES.values()][0]; if (!h) return -2; h.selectAll(); return h.getSelectedText().length; })()",
        );
        await q(
          "(() => { const h = window.__GT_PANES && [...window.__GT_PANES.values()][0]; h && h.copy(); return true; })()",
        );
        await new Promise((r) => setTimeout(r, 300));
        const clip = clipboard.readText();
        const clipOk = clip.length > 50 && clip.includes("roger@brain");
        results.push(
          "copy: " +
            (clipOk
              ? "PASS (selLen=" + selLen + " clipLen=" + clip.length + ")"
              : "FAIL selLen=" + selLen + " clipLen=" + clip.length),
        );

        // 5. State persistence
        const st = await q("window.terminal.stateLoad().then(s => s ? s.tabs.length : null)");
        results.push("state: " + (Number(st) >= 1 ? "PASS (" + st + " tabs)" : "FAIL (" + st + ")"));

        console.log("GT_VERIFY " + results.join(" | "));
        app.exit(results.some((r) => r.includes("FAIL")) ? 1 : 0);
      } catch (e) {
        console.error("GT_VERIFY error", e);
        app.exit(1);
      }
    }, 5000);
  }
  return win;
};

app.whenReady().then(() => {
  createWindow();

  const isMac = os.platform() === "darwin";
  const send = (channel: string) => () => mainWindow?.webContents.send(channel);
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        { label: "New Tab", accelerator: "CmdOrCtrl+T", click: send("menu:new-tab") },
        { label: "Close Tab", accelerator: "CmdOrCtrl+W", click: send("menu:close-tab") },
        { type: "separator" },
        { label: "Split Horizontally", accelerator: "CmdOrCtrl+D", click: send("menu:split-h") },
        { label: "Split Vertically", accelerator: "CmdOrCtrl+Shift+D", click: send("menu:split-v") },
        { type: "separator" },
        isMac ? { role: "close", label: "Close Window" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { label: "Copy", accelerator: "CmdOrCtrl+C", click: send("menu:edit:copy") },
        { label: "Paste", accelerator: "CmdOrCtrl+V", click: send("menu:edit:paste") },
        { label: "Select All", accelerator: "CmdOrCtrl+A", click: send("menu:edit:selectAll") },
        { type: "separator" },
        { label: "Clear Buffer", accelerator: "CmdOrCtrl+K", click: send("menu:edit:clear") },
        { type: "separator" },
        // Hidden native roles keep their shortcuts reserved in the menu; our
        // custom handlers above own the visible behaviour.
        { role: "selectAll", visible: false },
        { role: "undo", visible: false },
        { role: "redo", visible: false },
        { role: "cut", visible: false },
        { role: "copy", visible: false },
        { role: "paste", visible: false },
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

// Clipboard access from the renderer.
ipcMain.handle("clipboard:readText", () => clipboard.readText());
ipcMain.handle("clipboard:writeText", (_e, text: string) => clipboard.writeText(text));

// Persisted UI state (open tabs, splits) in userData.
const statePath = () => path.join(app.getPath("userData"), "state.json");
ipcMain.handle("state:load", async () => {
  try {
    return JSON.parse(await fs.readFile(statePath(), "utf8"));
  } catch {
    return null;
  }
});
ipcMain.handle("state:save", (_e, state: unknown) =>
  fs.writeFile(statePath(), JSON.stringify(state), "utf8"),
);

ptyManager.on("data", (id, data) => mainWindow?.webContents.send("pty:data", { id, data }));
ptyManager.on("exit", (id, exitCode) => mainWindow?.webContents.send("pty:exit", { id, exitCode }));

// expose platform to renderer via handles
ipcMain.handle("app:info", () => ({ platform: os.platform(), version: app.getVersion() }));

// Clean shutdown: kill every live PTY so no shell is left running.
app.on("before-quit", () => ptyManager.killAll());
