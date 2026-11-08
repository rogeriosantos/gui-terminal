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

    // Keyboard: terminal-aware copy/paste. Cmd/Ctrl+C copies when something is
    // selected, otherwise passes through to the shell as SIGINT.
    t.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      const key = ev.key.toLowerCase();
      if (IS_MAC) {
        if (ev.metaKey && key === "c") {
          if (t.hasSelection()) {
            doCopy();
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

    // Selection tracking for the context menu's Copy enabled state.
    const refreshSel = () => setHasSel(t.hasSelection());
    el.addEventListener("mouseup", refreshSel);
    el.addEventListener("dblclick", refreshSel);

    return () => {
      handles.delete(paneId);
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
