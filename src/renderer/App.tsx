import { useCallback, useEffect, useRef, useState } from "react";
import type { ShellKind } from "../shared/types.js";
import { TerminalPane } from "./TerminalPane.js";

export type Tab = {
  key: number;
  session: {
    id: number;
    pid: number;
    title: string;
  } | null;
  shell: ShellKind;
  host?: string;
  kind: "local" | "ssh";
  title: string;
  exited?: { code: number };
};

let nextTabKey = 1;

export function App() {
  const [shells, setShells] = useState<{ kind: string; label: string }[]>([]);
  const [hosts, setHosts] = useState<{ host: string; hostname?: string; user?: string }[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  useEffect(() => {
    window.terminal.listShells().then((s) => setShells(s as never));
    window.terminal.sshHosts().then(setHosts).catch(() => {});
    window.terminal.onMenuNewTab(() => newTab());
    window.terminal.onMenuCloseTab(() => closeTab(activeRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeRef = useRef<number | null>(null);
  activeRef.current = active;

  const newTab = useCallback(
    async (shell: ShellKind = "default", host?: string) => {
      const key = nextTabKey++;
      const tab: Tab = {
        key,
        session: null,
        shell,
        host,
        kind: host ? "ssh" : "local",
        title: host ?? "Terminal",
      };
      setTabs((t) => [...t, tab]);
      setActive(key);
      try {
        const s = await window.terminal.createSession(shell, host ? { host } : undefined);
        setTabs((t) => t.map((x) => (x.key === key ? { ...x, session: s } : x)));
      } catch (err) {
        setTabs((t) =>
          t.map((x) => (x.key === key ? { ...x, exited: { code: -1 }, title: `${host} failed` } : x)),
        );
        console.error(err);
      }
      return key;
    },
    [],
  );

  const closeTab = useCallback(
    (key: number | null) => {
      if (key === null) return;
      const tab = tabsRef.current.find((t) => t.key === key);
      if (tab?.session) window.terminal.kill(tab.session.id);
      setTabs((t) => {
        const remaining = t.filter((x) => x.key !== key);
        if (remaining.length === 0) {
          setActive(null);
          return [];
        }
        const idx = t.findIndex((x) => x.key === key);
        const next = remaining[Math.min(idx, remaining.length - 1)];
        setActive(next.key);
        return remaining;
      });
    },
    [],
  );

  // First tab on boot.
  useEffect(() => {
    if (tabs.length === 0 && shells.length > 0) {
      newTab("default");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shells.length > 0]);

  const onExit = useCallback((id: number, code: number) => {
    setTabs((t) => t.map((x) => (x.session?.id === id ? { ...x, exited: { code } } : x)));
  }, []);

  const activeTab = tabs.find((t) => t.key === active) ?? null;

  const connect = async (host: string) => {
    setConnecting(host);
    await newTab("default", host);
    setConnecting(null);
  };

  return (
    <div className="app">
      {/* Drag region: title bar area (macOS traffic lights live here) */}
      <div className="titlebar" />

      <div className="body">
        <aside className="sidebar">
          <div className="sidebar-title">
            <span className="logo">▚</span> GuiTerminal
          </div>

          <div className="section-label">Local</div>
          {shells.map((s) => (
            <button key={s.kind} className="side-item" onClick={() => newTab(s.kind as ShellKind)}>
              <span className="ico">$</span> {s.label}
            </button>
          ))}

          <div className="section-label">SSH</div>
          {hosts.length === 0 && <div className="side-hint">No hosts in ~/.ssh/config</div>}
          {hosts.map((h) => (
            <button
              key={h.host}
              className="side-item"
              disabled={connecting !== null}
              onClick={() => connect(h.host)}
              title={h.hostname ? `${h.user ? h.user + "@" : ""}${h.hostname}` : h.host}
            >
              <span className="ico">⇄</span> {h.host}
              {connecting === h.host ? "…" : ""}
            </button>
          ))}

          <div className="sidebar-footer">
            <span className="muted">v{APP_VERSION}</span>
          </div>
        </aside>

        <main className="main">
          {tabs.length === 0 ? (
            <div className="empty">
              <div className="empty-logo">▚</div>
              <div>Cmd+T for a new tab, or pick a shell / host on the left.</div>
            </div>
          ) : (
            <>
              <div className="tabbar" style={{ paddingLeft: TABBAR_PAD }}>
                {tabs.map((t) => (
                  <div
                    key={t.key}
                    className={"tab" + (t.key === active ? " active" : "")}
                    onClick={() => setActive(t.key)}
                  >
                    <span className={"tab-dot " + (t.kind === "ssh" ? "ssh" : "local")} />
                    <span className="tab-title">{t.title}</span>
                    {t.exited ? (
                      <span className="tab-exited" title={`exited (${t.exited.code})`}>⨯</span>
                    ) : null}
                    <button
                      className="tab-close"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(t.key);
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button className="tab-new" title="New Tab (Cmd+T)" onClick={() => newTab()}>
                  +
                </button>
              </div>

              <div className="panes">
                {tabs.map((t) => (
                  <div
                    key={t.key}
                    className={"pane" + (t.key === active ? " active" : "")}
                    style={t.key === active ? undefined : { display: "none" }}
                  >
                    <TerminalPane
                      tab={t}
                      focused={t.key === active}
                      onExited={onExit}
                      onTitle={(title) =>
                        setTabs((ts) => ts.map((x) => (x.key === t.key ? { ...x, title } : x)))
                      }
                    />
                  </div>
                ))}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

declare const APP_VERSION: string;

// macOS hiddenInset traffic lights sit at x=12; the custom tab bar starts
// after them on mac, flush on other platforms.
const IS_MAC = navigator.userAgent.includes("Mac");
const TABBAR_PAD = IS_MAC ? 78 : 0;
