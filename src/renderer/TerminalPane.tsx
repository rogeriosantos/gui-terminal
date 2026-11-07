import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { Tab } from "./App.js";

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

export function TerminalPane({
  tab,
  focused,
  onExited,
  onTitle,
}: {
  tab: Tab;
  focused: boolean;
  onExited: (id: number, code: number) => void;
  onTitle: (title: string) => void;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const [, forceRender] = useState(0);
  const reportedExit = useRef(false);

  // Create the xterm instance once per tab.
  useEffect(() => {
    if (!holder.current) return;
    const t = new Terminal({
      fontSize: 13,
      fontFamily: "'SF Mono', 'Menlo', 'Monaco', monospace",
      cursorBlink: true,
      allowProposedApi: true,
      theme: THEMES.dark,
      scrollback: 5000,
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(holder.current);
    try {
      f.fit();
    } catch {}
    term.current = t;
    fit.current = f;
    forceRender((n) => n + 1);
    return () => t.dispose();
  }, []);

  // Wire the session once it exists.
  useEffect(() => {
    const t = term.current;
    const s = tab.session;
    if (!t || !s) return;

    const write = t.onData((data) => window.terminal.write(s.id, data));

    const offOutput = window.terminal.onPtyOutput((chunk) => {
      if (chunk.id === s.id) t.write(chunk.data);
    });
    const offExit = window.terminal.onPtyExit((info) => {
      if (info.id === s.id && !reportedExit.current) {
        reportedExit.current = true;
        t.write(`\r\n\x1b[90m[process exited · code ${info.exitCode}]\x1b[0m\r\n`);
        onExited(s.id, info.exitCode);
      }
    });

    // Track the tab title via OSC 0/2 (what shells emit on PROMPT_COMMAND).
    const osc = t.parser.registerOscHandler(0, (data) => {
      onTitle(data);
      return false;
    });
    const osc2 = t.parser.registerOscHandler(2, (data) => {
      onTitle(data);
      return false;
    });

    // Initial size.
    window.terminal.resize(s.id, t.cols, t.rows);

    return () => {
      write.dispose();
      osc.dispose();
      osc2.dispose();
      offOutput();
      offExit();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.session?.id]);

  // Focus when the tab becomes active.
  useEffect(() => {
    if (focused) {
      term.current?.focus();
      try {
        fit.current?.fit();
      } catch {}
    }
  }, [focused, tab.session?.id]);

  // Refit on window resize.
  useEffect(() => {
    const s = tab.session;
    if (!s) return;
    const onResize = () => {
      const t = term.current;
      const f = fit.current;
      if (!t || !f || tab.exited) return;
      try {
        f.fit();
        window.terminal.resize(s.id, t.cols, t.rows);
      } catch {}
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [tab.session?.id, tab.exited]);

  return (
    <div
      ref={holder}
      className="xterm-holder"
      style={{ height: "100%", width: "100%", opacity: tab.session ? 1 : 0.4 }}
    />
  );
}
