import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export type Session = { id: number; pid: number; title: string } | null;


export interface PaneHandle {
  copy(): void;
  paste(): void;
  selectAll(): void;
  clear(): void;
  focus(): void;
  hasSelection(): boolean;
  getSelectedText(): string;
  write(data: string): void;
  /** "none" | "x10" | "vt200" | "drag" | "any" — how the app tracks the mouse. */
  mouseTrackingMode(): string;
}

const THEMES = {
  dark: {
    background: "#0c0e14",
    foreground: "#d6dbe5",
    cursor: "#ffb454",
    cursorAccent: "#0c0e14",
    selectionBackground: "#2a3b52",
    black: "#11131a",
    red: "#e06c75",
    green: "#77c07a",
    yellow: "#ffb454",
    blue: "#61afef",
    magenta: "#c678dd",
    cyan: "#56b6c2",
    white: "#d6dbe5",
    brightBlack: "#5c6370",
    brightRed: "#e06c75",
    brightGreen: "#77c07a",
    brightYellow: "#ffb454",
    brightBlue: "#61afef",
    brightMagenta: "#c678dd",
    brightCyan: "#56b6c2",
    brightWhite: "#ffffff",
  },
};

const IS_MAC = typeof navigator !== "undefined" && navigator.platform.startsWith("Mac");

export function TerminalPane({
  paneId,
  session,
  focused,
  handles,
  onExit,
  onTitle,
}: {
  paneId: number;
  session: Session;
  focused: boolean;
  handles: Map<number, PaneHandle>;
  onExit: (paneId: number, sessionId: number, code: number) => void;
  onTitle: (title: string) => void;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const [, forceRender] = useState(0);
  const reportedExit = useRef(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [hasSel, setHasSel] = useState(false);
  const sessionRef = useRef<Session>(session);
  sessionRef.current = session;

  // Create the xterm instance once per pane; own the copy/paste engine.
  useEffect(() => {
    if (!holder.current) return;
    const el = holder.current;
    const t = new Terminal({
      fontSize: 13,
      fontFamily: "'SF Mono', 'Menlo', 'Monaco', monospace",
      cursorBlink: true,
      allowProposedApi: true,
      theme: THEMES.dark,
      scrollback: 5000,
      // Option+click/drag forces local selection even when the running app
      // (claude/codex/lucy, vim, htop) enables mouse reporting. Shift+drag
      // works on every platform as the standard fallback.
      macOptionClickForcesSelection: true,
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(el);
    try {
      f.fit();
    } catch {}
    term.current = t;
    fit.current = f;
    forceRender((n) => n + 1);

    // --- copy/paste engine ---------------------------------------------------
    const doCopy = () => {
      const sel = t.getSelection();
      if (sel) window.terminal.clipboardWriteText(sel);
      return !!sel;
    };
    const doPaste = async () => {
      const text = await window.terminal.clipboardReadText();
      if (!text) return;
      const s = sessionRef.current;
      if (!s) return;
      // Bracketed paste when the program supports it; raw otherwise.
      const data = t.modes.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text;
      window.terminal.write(s.id, data);
    };

    const handle: PaneHandle = {
      copy: doCopy,
      paste: () => void doPaste(),
      selectAll: () => t.selectAll(),
      clear: () => {
        t.clear();
        t.focus();
      },
      focus: () => t.focus(),
      hasSelection: () => t.hasSelection(),
      getSelectedText: () => t.getSelection(),
      write: (data) => {
        const s = sessionRef.current;
        if (s) window.terminal.write(s.id, data);
      },
      mouseTrackingMode: () => term.current?.modes.mouseTrackingMode ?? "none",
    };
    handles.set(paneId, handle);
    // Test/inspection surface (harmless in production).
    (window as unknown as { __GT_PANES?: Map<number, PaneHandle> }).__GT_PANES = handles;
    const selTs = (window as unknown as { __GT_SEL_TS?: Map<number, number> }).__GT_SEL_TS;
    if (!selTs) {
      (window as unknown as { __GT_SEL_TS?: Map<number, number> }).__GT_SEL_TS = new Map();
    }

    // Keyboard: terminal-aware copy/paste. Cmd/Ctrl+C copies when something is
    // selected, otherwise passes through to the shell as SIGINT. When another
    // pane holds a FRESHER selection (user dragged there while keyboard focus
    // stayed here), copy that one instead - the user copies what they see
    // highlighted.
    const freshestForeignSelection = (): { text: string } | null => {
      const tsMap = (window as unknown as { __GT_SEL_TS?: Map<number, number> }).__GT_SEL_TS;
      if (!tsMap) return null;
      let best: { id: number; ts: number } | null = null;
      for (const [id, h] of handles.entries()) {
        if (id === paneId) continue;
        const ts = tsMap.get(id) ?? 0;
        if (h.hasSelection() && ts > (best?.ts ?? 0)) best = { id, ts };
      }
      if (!best) return null;
      const h = handles.get(best.id);
      const text = h?.getSelectedText() ?? "";
      return text ? { text } : null;
    };
    t.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      const key = ev.key.toLowerCase();
      if (IS_MAC) {
        if (ev.metaKey && key === "c") {
          if (t.hasSelection()) {
            doCopy();
            return false;
          }
          const foreign = freshestForeignSelection();
          if (foreign) {
            window.terminal.clipboardWriteText(foreign.text);
            return false;
          }
          return true; // SIGINT
        }
        if (ev.metaKey && key === "v") {
          void doPaste();
          return false;
        }
        if (ev.metaKey && key === "a") {
          t.selectAll();
          return false;
        }
        if (ev.metaKey && key === "k") {
          t.clear();
          return false;
        }
      } else {
        if (ev.ctrlKey && ev.shiftKey && key === "c") {
          doCopy();
          return false;
        }
        if (ev.ctrlKey && key === "c" && t.hasSelection()) {
          doCopy();
          t.clearSelection();
          return false;
        }
        if (ev.ctrlKey && ev.shiftKey && key === "v") {
          void doPaste();
          return false;
        }
        if (ev.ctrlKey && key === "v" && !ev.shiftKey) {
          void doPaste();
          return false;
        }
        if (ev.ctrlKey && ev.shiftKey && key === "a") {
          t.selectAll();
          return false;
        }
      }
      return true;
    });

    // Termius-style mouse disambiguation: the app keeps its mouse (wheel,
    // clicks), but a DRAG always becomes a text selection — implemented with
    // xterm's programmatic select() API so synthetic-event trust never matters.
    //   mousedown         -> hold the event back (mouse reporting apps)
    //   move > 4px        -> drag: select from the press cell to the current
    //                        cell on every move (live feedback)
    //   mouseup w/o drag  -> click: replay mousedown+up to xterm for the app
    const DRAG_THRESHOLD = 4;
    let held: { x: number; y: number; ev: MouseEvent } | null = null;
    let dragging: boolean = false;
    let startCell: { x: number; y: number } | null = null;

    const clone = (type: string, e: MouseEvent, over: Partial<MouseEventInit>) =>
      new MouseEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        detail: e.detail, view: window,
        screenX: e.screenX, screenY: e.screenY,
        clientX: e.clientX, clientY: e.clientY,
        ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey,
        button: e.button, buttons: e.buttons,
        relatedTarget: e.relatedTarget,
        ...over,
      });

    const cellFromEvent = (e: { clientX: number; clientY: number }) => {
      const rect = el.getBoundingClientRect();
      // Use xterm's own cell dimensions: char width from a rendered row.
      const row = el.querySelector(".xterm-rows > div") as HTMLElement | null;
      if (!row) return null;
      const rh = row.getBoundingClientRect();
      const cellH = rh.height || 15;
      // approximate cell width via monospace advance: measure one char
      const span = row.querySelector("span") as HTMLElement | null;
      let cellW = 8;
      if (span) {
        const sr = span.getBoundingClientRect();
        if (sr.width > 0) cellW = sr.width;
      }
      const x = Math.floor((e.clientX - rect.left) / cellW);
      const y = Math.floor((e.clientY - rect.top) / cellH);
      if (x < 0 || y < 0 || x >= t.cols) return null;
      return { x, y };
    };

    const onMouseDownCapture = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (t.modes.mouseTrackingMode === "none") return;
      if (e.shiftKey || e.altKey) return;
      held = { x: e.clientX, y: e.clientY, ev: e };
      e.stopImmediatePropagation();
      e.preventDefault();
    };

    const onMouseMoveCapture = (e: MouseEvent) => {
      if (!held) return;
      if (!dragging) {
        if (Math.hypot(e.clientX - held.x, e.clientY - held.y) < DRAG_THRESHOLD) return;
        dragging = true;
        startCell = cellFromEvent({ clientX: held.x, clientY: held.y });
        if (!startCell) return;
      }
      e.stopImmediatePropagation();
      const end = cellFromEvent(e);
      if (!end || !startCell) return;
      // Live selection while dragging.
      if (startCell.y === end.y) {
        const [sx, ex] = startCell.x <= end.x ? [startCell.x, end.x] : [end.x, startCell.x];
        t.select(sx, startCell.y + t.buffer.active.viewportY, ex - sx + 1);
      } else {
        const [sy, ey] = startCell.y <= end.y ? [startCell, end] : [end, startCell];
        t.select(sy.x, sy.y + t.buffer.active.viewportY, (ey.y - sy.y) * t.cols + (ey.x - sy.x) + 1);
      }
    };

    const onMouseUpCapture = (e: MouseEvent) => {
      if (!held) return;
      const wasDrag = dragging;
      const h = held;
      held = null;
      dragging = false;
      if (wasDrag) {
        e.stopImmediatePropagation();
        // Stamp the selection as fresh for copy routing.
        const m = (window as unknown as { __GT_SEL_TS?: Map<number, number> }).__GT_SEL_TS;
        m?.set(paneId, Date.now());
        setHasSel(t.hasSelection());
        return;
      }
      // Plain click: replay to xterm so the app receives it.
      e.stopImmediatePropagation();
      (e.target as Element | null)?.dispatchEvent(clone("mousedown", h.ev, {}));
      (e.target as Element | null)?.dispatchEvent(clone("mouseup", e, {}));
    };

    const onWheelCapture = (e: WheelEvent) => {
      if (t.modes.mouseTrackingMode === "none") return;
      e.stopPropagation();
    };

    el.addEventListener("mousedown", onMouseDownCapture, true);
    el.addEventListener("mousemove", onMouseMoveCapture, true);
    el.addEventListener("mouseup", onMouseUpCapture, true);
    el.addEventListener("wheel", onWheelCapture, true);

    // Right-click context menu.
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      setHasSel(t.hasSelection());
      setMenu({ x: e.clientX, y: e.clientY });
    };
    el.addEventListener("contextmenu", onContextMenu);

    // Middle-click paste (X11 style).
    const onAuxClick = (e: MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault();
        void doPaste();
      }
    };
    el.addEventListener("auxclick", onAuxClick);

    // Selection tracking for the context menu's Copy enabled state + copy
    // routing: the pane with the FRESHEST selection wins Cmd+C (keyboard
    // focus can sit in another pane after a split).
    const refreshSel = () => {
      setHasSel(t.hasSelection());
      if (t.hasSelection()) {
        const m = (window as unknown as { __GT_SEL_TS?: Map<number, number> }).__GT_SEL_TS;
        m?.set(paneId, Date.now());
      }
    };
    const selSub = t.onSelectionChange(refreshSel);
    el.addEventListener("mouseup", refreshSel);
    el.addEventListener("dblclick", refreshSel);

    return () => {
      handles.delete(paneId);
      selSub.dispose();
      el.removeEventListener("mousedown", onMouseDownCapture, true);
      el.removeEventListener("mousemove", onMouseMoveCapture, true);
      el.removeEventListener("mouseup", onMouseUpCapture, true);
      el.removeEventListener("wheel", onWheelCapture, true);
      el.removeEventListener("contextmenu", onContextMenu);
      el.removeEventListener("auxclick", onAuxClick);
      el.removeEventListener("mouseup", refreshSel);
      el.removeEventListener("dblclick", refreshSel);
      t.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId]);

  // Wire the session once it exists.
  useEffect(() => {
    const t = term.current;
    const s = session;
    if (!t || !s) return;

    const writeSub = t.onData((data) => window.terminal.write(s.id, data));

    const offOutput = window.terminal.onPtyOutput((chunk) => {
      if (chunk.id === s.id) t.write(chunk.data);
    });
    const offExit = window.terminal.onPtyExit((info) => {
      if (info.id === s.id && !reportedExit.current) {
        reportedExit.current = true;
        t.write(`\r\n\x1b[90m[process exited · code ${info.exitCode}]\x1b[0m\r\n`);
        onExit(paneId, s.id, info.exitCode);
        forceRender((n) => n + 1);
      }
    });

    const osc = t.parser.registerOscHandler(0, (data) => {
      onTitle(data);
      return false;
    });
    const osc2 = t.parser.registerOscHandler(2, (data) => {
      onTitle(data);
      return false;
    });

    window.terminal.resize(s.id, t.cols, t.rows);

    return () => {
      writeSub.dispose();
      osc.dispose();
      osc2.dispose();
      offOutput();
      offExit();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id]);

  // Focus + fit when the pane becomes focused.
  useEffect(() => {
    if (focused) {
      term.current?.focus();
      try {
        fit.current?.fit();
        // Coming back from a hidden tab the glyph atlas can be stale
        // (fonts measured at 0 size); rebuild it.
        term.current?.clearTextureAtlas();
        const s = sessionRef.current;
        const t = term.current;
        if (s && t) window.terminal.resize(s.id, t.cols, t.rows);
      } catch {}
    } else {
      // Losing keyboard focus also gives up the selection: a stale selection
      // in an unfocused pane is what Cmd+C wrongly copied.
      term.current?.clearSelection();
    }
  }, [focused, session?.id]);

  // Refit on window resize.
  useEffect(() => {
    const s = session;
    if (!s) return;
    const onResize = () => {
      const t = term.current;
      const f = fit.current;
      if (!t || !f) return;
      try {
        f.fit();
        window.terminal.resize(s.id, t.cols, t.rows);
      } catch {}
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id]);

  const h = handles.get(paneId);

  return (
    <div className="xterm-holder">
      <div ref={holder} className="xterm-mount" style={{ height: "100%", width: "100%" }} />
      {menu && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }}>
          <button
            disabled={!hasSel}
            onClick={() => {
              h?.copy();
              setMenu(null);
            }}
          >
            Copy
          </button>
          <button
            onClick={() => {
              h?.paste();
              setMenu(null);
            }}
          >
            Paste
          </button>
          <button
            onClick={() => {
              h?.selectAll();
              setMenu(null);
            }}
          >
            Select All
          </button>
          <button
            onClick={() => {
              h?.clear();
              setMenu(null);
            }}
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
