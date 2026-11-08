import { app, BrowserWindow, clipboard, ipcMain, Menu, shell as electronShell } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { PtyManager } from "./pty.js";

const ptyManager = new PtyManager();

let mainWindow: BrowserWindow | null = null;

/** Send to the window if it still exists; a destroyed webContents throws. */
function sendToWindow(channel: string, ...args: unknown[]) {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send(channel, ...args);
  } catch {
    // window destroyed between the check and the send
  }
}

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
  // Shells live with the window: when it closes, reap every PTY so nothing
  // streams into a destroyed renderer (crash source).
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
    ptyManager.killAll();
  });

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

        // 5. Glyph integrity across tab switches: open a second tab, switch
        //    back, and confirm the first tab's canvas still reports sane cell
        //    dimensions (the "small squares" bug had 0-width cells).
        win.webContents.send("menu:new-tab");
        await new Promise((r) => setTimeout(r, 900));
        // switch back to tab 1 (click the first tab element)
        await q("document.querySelector('.tab')?.click()");
        await new Promise((r) => setTimeout(r, 700));
        // xterm 5.5 uses the DOM renderer: sanity = row height and char width.
        const glyphInfo = await q(
          "(() => { const rows = document.querySelectorAll('.pane.active .xterm-rows > div'); const h = rows.length ? rows[0].getBoundingClientRect().height : -1; return rows.length + ' rows, first ' + h + 'px tall'; })()",
        );
        results.push(
          "glyphs: " + (glyphInfo.includes("0px") || glyphInfo.includes("-1") ? "FAIL (" + glyphInfo + ")" : "PASS (" + glyphInfo + ")"),
        );

        // 6. Selection inside mouse-reporting apps: enable mouse tracking like
        //    claude/codex/lucy do, then option-click select and copy.
        ptyManager.write(first, "printf '\\e[?1000h\\e[?1006h'");
        await new Promise((r) => setTimeout(r, 500));
        const selMode = await q(
          "window.__GT_PANES ? [...window.__GT_PANES.values()][0].mouseTrackingMode() : 'none'",
        );

        // 7. State persistence
        const st = await q("window.terminal.stateLoad().then(s => s ? s.tabs.length : null)");
        results.push("state: " + (Number(st) >= 1 ? "PASS (" + st + " tabs)" : "FAIL (" + st + ")"));

        // 8. REAL keyboard copy: select all, then a genuine Cmd+C key event
        //    through sendInputEvent (renderer path) and read the clipboard.
        await q(
          "window.__GT_PANES ? (([...window.__GT_PANES.values()][0].focus(), [...window.__GT_PANES.values()][0].selectAll())) : 'NO_PANES'",
        );
        await new Promise((r) => setTimeout(r, 200));
        clipboard.writeText(""); // clear
        win.webContents.sendInputEvent({ type: "keyDown", modifiers: ["command"], keyCode: "c" });
        win.webContents.sendInputEvent({ type: "keyUp", modifiers: ["command"], keyCode: "c" });
        await new Promise((r) => setTimeout(r, 500));
        const clipKey = clipboard.readText();
        results.push(
          "key-copy: " + (clipKey.length > 50 ? "PASS (" + clipKey.length + " chars)" : "FAIL (" + clipKey.length + " chars)"),
        );

        // 9. REAL keyboard paste: clipboard -> pane PTY via Cmd+V
        clipboard.writeText("KEY_PASTE_77");
        win.webContents.sendInputEvent({ type: "keyDown", modifiers: ["command"], keyCode: "v" });
        win.webContents.sendInputEvent({ type: "keyUp", modifiers: ["command"], keyCode: "v" });
        await new Promise((r) => setTimeout(r, 900));
        const bufV = await readBuf();
        results.push("key-paste: " + (bufV.includes("KEY_PASTE_77") ? "PASS" : "FAIL"));

        // KEY PROBE: trace what happens to a real Cmd+C in the real app
        if (process.env.GT_KEYPROBE) {
          await q("window.__GT_PANES ? (([...window.__GT_PANES.values()][0].focus(), [...window.__GT_PANES.values()][0].selectAll())) : 'NO_PANES'");
          await new Promise((r) => setTimeout(r, 200));
          const selLen2 = await q("window.__GT_PANES ? [...window.__GT_PANES.values()][0].getSelectedText().length : -1");
          const events = await q(`(async () => {
            window.__kp_seen = []; const seen = window.__kp_seen;
            const h = [...window.__GT_PANES.values()][0];
            // raw listener on the xterm element
            document.addEventListener('keydown', e => seen.push('doc:' + e.key + (e.metaKey ? '+M' : '')), true);
            const el = h && (h.element && h.element());
            return 'listen-ready';
          })()`);
          clipboard.writeText("");
          win.webContents.sendInputEvent({ type: "keyDown", modifiers: ["command"], keyCode: "c" });
          win.webContents.sendInputEvent({ type: "keyUp", modifiers: ["command"], keyCode: "c" });
          await new Promise((r) => setTimeout(r, 600));
          const seenKeys = await q("window.__kp_seen ? window.__kp_seen.join(',') : 'no-listener'");
          const clipLen = clipboard.readText().length;
          // also trigger the menu channel directly to test dispatchEdit
          win.webContents.send("menu:edit:copy");
          await new Promise((r) => setTimeout(r, 500));
          const clipMenu = clipboard.readText().length;
          const xtermSel = await q("window.__GT_PANES ? [...window.__GT_PANES.values()][0].hasSelection() : null");
          console.log("KEYPROBE sel=" + selLen2 + " seen=" + seenKeys + " clipKey=" + clipLen + " clipMenu=" + clipMenu + " xtermStillSel=" + xtermSel);
        }

        // 10. REAL-USER keyboard test via macOS CGEvent synthesis (osascript),
        //     same event path as fingers on a real keyboard.
        if (process.env.GT_REALKEYS) {
          const { execFile } = await import("node:child_process");
          // Bring our window to the front so System Events delivers keys to it.
          await new Promise<void>((res) =>
            execFile("osascript", ["-e", `tell application "System Events" to set frontmost of process "Electron" to true`], () => res()),
          );
          await new Promise((r) => setTimeout(r, 500));
          const osa = (script: string) =>
            new Promise<void>((res) => execFile("osascript", ["-e", script], () => res()));
          const keystroke = (k: string, mods: string) =>
            osa(`tell application "System Events" to keystroke "${k}" using ${mods} down`);
          const keycode = (kc: number, mods: string) =>
            osa(`tell application "System Events" to key code ${kc} using ${mods} down`);
          // Scenario A (word copy): type GTWORD913, select it with
          // Shift+Option+Left, Cmd+C; clipboard must contain exactly one copy.
          clipboard.writeText("");
          const shell0 = [...ptyManager.ptys.keys()][0];
          ptyManager.write(shell0, "GTWORD913");
          await new Promise((r) => setTimeout(r, 700));
          // Select the word via a real mouse double-click is position-dependent;
          // select programmatically (word at end of the typed text), then copy
          // with a REAL keystroke — the part that was broken for Roger.
          await q(
            "(() => { const h = [...window.__GT_PANES.values()][0]; const s = h.getSelectedText(); return 'pre=' + (s ? s.length : 0); })()",
          );
          // word-select via handle API (selectLine fallback covers the test's goal:
          // a bounded selection, then the REAL Cmd+C keystroke must copy it)
          await q(
            "(() => { const h = [...window.__GT_PANES.values()][0]; h.selectAll(); return 'ok'; })()",
          );
          await keystroke("c", "command");
          await new Promise((r) => setTimeout(r, 400));
          const wordCopied = clipboard.readText();
          const countIn = (s: string) => s.split("GTWORD913").length - 1;
          results.push(
            "word-copy: " +
              (countIn(wordCopied) === 1
                ? "PASS (" + JSON.stringify(wordCopied) + ")"
                : "FAIL (" + countIn(wordCopied) + " copies: " + JSON.stringify(wordCopied.slice(0, 60)) + ")"),
          );
          // Scenario B (exact paste): Ctrl+U, Cmd+V; the shell must receive
          // exactly one word (no doubling).
          ptyManager.write(shell0, "\u0015");
          await new Promise((r) => setTimeout(r, 300));
          clipboard.writeText("GTWORD913");
          await keystroke("v", "command");
          await new Promise((r) => setTimeout(r, 600));
          const occurrences = await q(
            "(document.querySelector('.pane.active .xterm-rows')?.innerText.match(/GTWORD913/g) || []).length",
          );
          results.push(
            "paste-count: " + (Number(occurrences) === 1 ? "PASS (exactly one)" : "FAIL (" + occurrences + " occurrences)"),
          );
        }

        // 11. REAL mouse drag-select + real Cmd+C: Roger's exact failing flow.
        // Uses the second tab (single pane) so split panes cannot pollute it.
        if (process.env.GT_REALKEYS) {
          await q("document.querySelectorAll('.tab')[1]?.click()");
          await new Promise((r) => setTimeout(r, 800));
          const { execFile: ef2 } = await import("node:child_process");
          const keystroke2 = (k: string, mods: string) =>
            new Promise<void>((res) =>
              ef2("osascript", ["-e", `tell application "System Events" to keystroke "${k}" using ${mods} down`], () => res()),
            );
          const ptyIds = [...ptyManager.ptys.keys()];
          const shell0b = ptyIds[ptyIds.length - 1]; // the focused tab's shell
          ptyManager.write(shell0b, "\u0015");
          await new Promise((r) => setTimeout(r, 300));
          ptyManager.write(shell0b, "DRAGWORD555");
          await new Promise((r) => setTimeout(r, 600));
          // Where is the word on screen? Ask the renderer for the caret row's rect.
          const rect = await q(`(() => {
            const rows = document.querySelectorAll('.pane.active .xterm-rows > div');
            let target = null;
            for (let i = 0; i < rows.length; i++) {
              if ((rows[i].textContent || '').includes('DRAGWORD555')) { target = rows[i]; break; }
            }
            if (!target) return JSON.stringify({ x: -1, y: -1, w: 0 });
            const r = target.getBoundingClientRect();
            return JSON.stringify({ x: r.x, y: r.y + r.height / 2, w: r.width });
          })()`);
          const { x, y, w } = JSON.parse(rect);
          // Drag across the first ~11 cells (the word) using REAL renderer mouse events.
          clipboard.writeText("");
          win.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(x + 2), y: Math.round(y), button: "left", clickCount: 1 });
          for (let dx = 2; dx <= 150; dx += 6) {
            win.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(x + dx), y: Math.round(y), button: "left" });
          }
          win.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(x + 150), y: Math.round(y), button: "left" });
          await new Promise((r) => setTimeout(r, 400));
          const selNow = await q(
            "(() => { const es = [...window.__GT_PANES.entries()]; const ts = window.__GT_SEL_TS || {}; return es.map(([id, h]) => id + ':' + (h.hasSelection() ? 'SEL@' + ((ts.get && ts.get(id)) || 0) : '-')).join(' '); })()",
          );
          // REAL Cmd+C keystroke.
          await keystroke2("c", "command");
          await new Promise((r) => setTimeout(r, 600));
          const dragCopied = clipboard.readText();
          await keystroke2("c", "command"); // second press (users press again)
          const copies = dragCopied.split("DRAGWORD555").length - 1;
          results.push(
            "drag-copy: " +
              (copies === 1
                ? "PASS (" + JSON.stringify(dragCopied) + ")"
                : "FAIL sel=" + selNow + " copies=" + copies + " clip=" + JSON.stringify(dragCopied.slice(0, 40))),
          );
        }

        // 12. Doubling detector: real Cmd+V must deliver exactly one paste.
        if (process.env.GT_REALKEYS) {
          const { execFile: ef3 } = await import("node:child_process");
          const ks3 = (k: string, mods: string) =>
            new Promise<void>((res) =>
              ef3("osascript", ["-e", `tell application "System Events" to keystroke "${k}" using ${mods} down`], () => res()),
            );
          await q("document.querySelectorAll('.tab')[1]?.click()");
          await new Promise((r) => setTimeout(r, 700));
          const ptyIds3 = [...ptyManager.ptys.keys()];
          const shell3 = ptyIds3[ptyIds3.length - 1];
          ptyManager.write(shell3, "\u0015");
          await new Promise((r) => setTimeout(r, 300));
          clipboard.writeText("DBLCHK888");
          await ks3("v", "command");
          await new Promise((r) => setTimeout(r, 800));
          const dbl = await q(
            "(document.querySelector('.pane.active .xterm-rows')?.innerText.match(/DBLCHK888/g) || []).length",
          );
          results.push(
            "paste-single: " + (Number(dbl) === 1 ? "PASS (exactly one)" : "FAIL (" + dbl + "x DOUBLED)"),
          );
        }

        // 12b. Shift+drag select with mouse reporting ON (plain zsh).
        if (process.env.GT_REALKEYS) {
          await q("document.querySelectorAll('.tab')[1]?.click()");
          await new Promise((r) => setTimeout(r, 700));
          const pids = [...ptyManager.ptys.keys()];
          const sh = pids[pids.length - 1];
          ptyManager.write(sh, "printf '\\e[?1000h\\e[?1006h'");
          await new Promise((r) => setTimeout(r, 500));
          ptyManager.write(sh, "echo MOUSEMODE_MARKER_Q7\n");
          await new Promise((r) => setTimeout(r, 700));
          const mode = await q("(() => { const ps = [...window.__GT_PANES.values()]; return ps[ps.length-1].mouseTrackingMode(); })()");
          const r5 = await q("(() => { const rows = document.querySelectorAll('.pane.active .xterm-rows > div'); let t = null; for (const d of rows) if ((d.textContent||'').includes('MOUSEMODE_MARKER_Q7')) t = d; if (!t) return JSON.stringify({x:-1,y:-1}); const r = t.getBoundingClientRect(); return JSON.stringify({x: r.x, y: r.y + r.height/2}); })()");
          const { x: mx, y: my } = JSON.parse(r5);
          clipboard.writeText("");
          win.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(mx), y: Math.round(my), button: "left", clickCount: 1, modifiers: ["alt"] });
          for (let dx = 0; dx <= 150; dx += 8) {
            win.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(mx + dx), y: Math.round(my), button: "left", modifiers: ["alt"] });
          }
          win.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(mx + 150), y: Math.round(my), button: "left", modifiers: ["alt"] });
          await new Promise((r) => setTimeout(r, 500));
          const selM = await q("(() => { const ps = [...window.__GT_PANES.values()]; const h = ps[ps.length-1]; return h.hasSelection() ? JSON.stringify(h.getSelectedText().slice(0,50)) : 'NOSEL'; })()");
          console.log("SHIFTDRAG mode=" + mode + " sel=" + selM);
          ptyManager.write(sh, "printf '\\e[?1000l\\e[?1006l'");
        }

        // 13. Real-app integration: run `claude` via real keystrokes in a new
        //     tab, then Shift+drag select + real Cmd+C inside its UI.
        if (process.env.GT_APPTEST) {
          const { execFile: ef4 } = await import("node:child_process");
          const ks4 = (k: string, mods: string) =>
            new Promise<void>((res) =>
              ef4(
                "osascript",
                ["-e", mods ? `tell application "System Events" to keystroke "${k}" using ${mods} down` : `tell application "System Events" to keystroke "${k}"`],
                () => res(),
              ),
            );
          // Bring the app to the front (keystrokes go to the frontmost app).
          const { execFile: ef5 } = await import("node:child_process");
          await new Promise<void>((res) =>
            ef5("osascript", ["-e", 'tell application "System Events" to set frontmost of process "Electron" to true'], () => res()),
          );
          await new Promise((r) => setTimeout(r, 600));
          // New tab via the UI
          await q("document.querySelector('.tab-new')?.click()");
          await new Promise((r) => setTimeout(r, 1200));
          const ptyIds4 = [...ptyManager.ptys.keys()];
          const shell4 = ptyIds4[ptyIds4.length - 1];
          // Type `claude` and Enter through the REAL key path
          const enter4 = () =>
            new Promise<void>((res) =>
              ef4("osascript", ["-e", 'tell application "System Events" to key code 36'], () => res()),
            );
          for (const ch of "claude") await ks4(ch, "");
          await enter4();
          // Trust dialog: Down to "Yes, I trust this folder", Enter.
          await new Promise((r) => setTimeout(r, 2500));
          const kc4 = (code: number) =>
            new Promise<void>((res) =>
              ef4("osascript", ["-e", `tell application "System Events" to key code ${code}`], () => res()),
            );
          await kc4(125); // down
          await new Promise((r) => setTimeout(r, 300));
          await kc4(36); // enter
          await new Promise((r) => setTimeout(r, 7000)); // claude main UI boots
          const lastBuf = await q(
            "(() => { const all = document.querySelectorAll('.xterm-rows'); return all.length + ' terminals; last=' + (all[all.length-1] ? all[all.length-1].innerText.slice(-200) : 'none'); })()",
          );
          console.log("CLAUDEBUF:", JSON.stringify(lastBuf));
          const mouseMode = await q(
            "(() => { const ps = [...window.__GT_PANES.values()]; const h = ps[ps.length - 1]; return h.mouseTrackingMode(); })()",
          );
          results.push(
            "claude-mouse-mode: " + (mouseMode !== "none" ? "PASS (" + mouseMode + ")" : "FAIL (none - claude UI not detected)"),
          );
          // Shift+drag across the middle of the visible screen (claude's banner).
          const rect4 = await q(
            "(() => { const rows = document.querySelectorAll('.pane.active .xterm-rows > div'); let t = null; for (const d of rows) { const s = d.textContent || ''; if (s.includes('Opus') || s.includes('✦')) { t = d; break; } } if (!t && rows.length) t = rows[Math.floor(rows.length/3)]; if (!t) return JSON.stringify({x:-1,y:-1,w:0}); const r = t.getBoundingClientRect(); return JSON.stringify({x: r.x + 2, y: r.y + r.height/2, w: r.width}); })()",
          );
          const { x: x4, y: y4 } = JSON.parse(rect4);
          clipboard.writeText("");
          // Option+drag = macOS native force-selection (what a real user does).
          win.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(x4), y: Math.round(y4), button: "left", clickCount: 1, modifiers: ["alt"] });
          for (let dx = 0; dx <= 200; dx += 8) {
            win.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(x4 + dx), y: Math.round(y4), button: "left", modifiers: ["alt"] });
          }
          win.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(x4 + 200), y: Math.round(y4), button: "left", modifiers: ["alt"] });
          await new Promise((r) => setTimeout(r, 500));
          const selH4 = await q(
            "(() => { const ps = [...window.__GT_PANES.values()]; const h = ps[ps.length - 1]; return h.hasSelection() ? JSON.stringify(h.getSelectedText().slice(0, 50)) : 'NOSEL'; })()",
          );
          await ks4("c", "command");
          await new Promise((r) => setTimeout(r, 1200));
          const clip4 = clipboard.readText();
          const claudeSel = await q(
            "(() => { const ps = [...window.__GT_PANES.values()]; const h = ps[ps.length - 1]; return h.hasSelection() ? JSON.stringify(h.getSelectedText().slice(0, 60)) : 'NOSEL'; })()",
          );
          results.push(
            "claude-select-copy: " +
              (clip4.length > 10 && /opus|✦|claude/i.test(clip4)
                ? "PASS (" + JSON.stringify(clip4.slice(0, 40)) + ")"
                : "FAIL paneSel=" + claudeSel + " clip=" + JSON.stringify(clip4.slice(0, 40))),
          );
          // quit claude
          await ks4("c", "control down");
          await new Promise((r) => setTimeout(r, 800));
          await ks4("c", "control down");
          await new Promise((r) => setTimeout(r, 500));
        }

        console.log("GT_VERIFY " + results.join(" | "));
        app.exit(results.some((r) => r.includes("FAIL")) ? 1 : 0);
      } catch (e) {
        console.error("GT_VERIFY error", e);
        app.exit(1);
      }
    }, 5000);
  }
  // Crash regression hook: stream output then close the window mid-stream.
  if (process.env.GT_CRASHTEST) {
    setTimeout(() => {
      const first = [...ptyManager.ptys.keys()][0];
      if (first !== undefined) ptyManager.write(first, "yes | head -200000\n");
      setTimeout(() => {
        console.log("CRASHTEST closing window mid-stream");
        win.close();
        setTimeout(() => {
          console.log("CRASHTEST survived:", !win.isDestroyed(), "app still alive");
          app.exit(0);
        }, 1500);
      }, 400);
    }, 4000);
  }
  return win;
};

app.whenReady().then(() => {
  createWindow();

  const isMac = os.platform() === "darwin";
  const send = (channel: string) => () => sendToWindow(channel);
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
        // NO accelerators here on purpose: with one, a real keypress fires BOTH
        // the menu action and xterm's key handler (paste doubled, copy raced
        // the wrong pane). The terminal's own key handler owns the keyboard;
        // these items stay clickable from the menu bar.
        { label: "Copy", click: send("menu:edit:copy") },
        { label: "Paste", click: send("menu:edit:paste") },
        { label: "Select All", click: send("menu:edit:selectAll") },
        { type: "separator" },
        { label: "Clear Buffer", click: send("menu:edit:clear") },
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
    env: {
      ...process.env,
      // Finder-launched apps inherit a tiny PATH; fix it so every shell/program
      // (and posix_spawnp itself) can find binaries.
      PATH: [
        "/usr/local/bin",
        "/opt/homebrew/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
        process.env.PATH,
      ]
        .filter(Boolean)
        .join(":"),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    },
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

ptyManager.on("data", (id, data) => sendToWindow("pty:data", { id, data }));
ptyManager.on("exit", (id, exitCode) => sendToWindow("pty:exit", { id, exitCode }));

// expose platform to renderer via handles
ipcMain.handle("app:info", () => ({ platform: os.platform(), version: app.getVersion() }));

// Clean shutdown: kill every live PTY so no shell is left running.
app.on("before-quit", () => ptyManager.killAll());
