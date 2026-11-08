import { useCallback, useEffect, useRef, useState } from "react";
import type { ShellKind } from "../shared/types.js";
import { TerminalPane, type PaneHandle } from "./TerminalPane.js";
import {
  type PaneNode,
  firstLeaf,
  leafIds,
  newPaneId,
  removeLeaf,
  splitLeaf,
} from "./panes.js";

type Session = { id: number; pid: number; title: string } | null;

type Tab = {
  key: number;
  shell: ShellKind;
  host?: string;
  kind: "local" | "ssh";
  title: string;
  exited?: { code: number };
  panes: PaneNode;
  focusedPane: number;
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
  const activeRef = useRef<number | null>(null);
  activeRef.current = active;

  // paneId -> live session; paneId -> imperative terminal handle.
  const sessions = useRef(new Map<number, Session>());
  const handles = useRef(new Map<number, PaneHandle>());
  const booted = useRef(false);

  const ensurePaneSession = useCallback(async (paneId: number, shell: ShellKind, host?: string) => {
    if (sessions.current.has(paneId)) return;
    sessions.current.set(paneId, null);
    try {
      const s = await window.terminal.createSession(shell, host ? { host } : undefined);
      sessions.current.set(paneId, { id: s.id, pid: s.pid, title: s.title });
    } catch {
      sessions.current.set(paneId, null);
    }
    setTabs((t) => [...t]); // re-render so the pane picks its session up
  }, []);

  const newTab = useCallback(
    async (shell: ShellKind = "default", host?: string) => {
      const key = nextTabKey++;
      const paneId = newPaneId();
      const tab: Tab = {
        key,
        shell,
        host,
        kind: host ? "ssh" : "local",
        title: host ?? "Terminal",
        panes: { type: "leaf", id: paneId },
        focusedPane: paneId,
      };
      setTabs((t) => [...t, tab]);
      setActive(key);
      return tab;
    },
    [],
  );

  const closeTab = useCallback((key: number | null) => {
    if (key === null) return;
    const tab = tabsRef.current.find((t) => t.key === key);
    if (tab) {
      for (const paneId of leafIds(tab.panes)) {
        const s = sessions.current.get(paneId);
        if (s) window.terminal.kill(s.id);
        sessions.current.delete(paneId);
        handles.current.delete(paneId);
      }
    }
    setTabs((t) => {
      const idx = t.findIndex((x) => x.key === key);
      const remaining = t.filter((x) => x.key !== key);
      if (remaining.length === 0) {
        setActive(null);
        return [];
      }
      setActive(remaining[Math.min(idx, remaining.length - 1)].key);
      return remaining;
    });
  }, []);

  const splitPane = useCallback((dir: "h" | "v") => {
    setTabs((t) =>
      t.map((tab) => {
        if (tab.key !== activeRef.current) return tab;
        const newId = newPaneId();
        return {
          ...tab,
          panes: splitLeaf(tab.panes, tab.focusedPane, dir, newId),
          focusedPane: newId,
        };
      }),
    );
  }, []);

  const closePane = useCallback((paneId: number) => {
    const tabKey = activeRef.current;
    setTabs((t) =>
      t.map((tab) => {
        if (tab.key !== tabKey) return tab;
        if (tab.panes.type === "leaf") return tab; // last pane = close the tab instead
        const s = sessions.current.get(paneId);
        if (s) window.terminal.kill(s.id);
        sessions.current.delete(paneId);
        handles.current.delete(paneId);
        const panes = removeLeaf(tab.panes, paneId);
        if (!panes) return tab;
        return { ...tab, panes, focusedPane: firstLeaf(panes) };
      }),
    );
  }, []);

  const focusPane = useCallback((tabKey: number, paneId: number) => {
    setActive(tabKey);
    setTabs((t) => t.map((x) => (x.key === tabKey ? { ...x, focusedPane: paneId } : x)));
  }, []);

  const onExit = useCallback((paneId: number, sessionId: number, code: number) => {
    setTabs((t) => {
      let changed = false;
      const next = t.map((tab) => {
        const paneStillThere = leafIds(tab.panes).includes(paneId);
        if (!paneStillThere) return tab;
        changed = true;
        return tab.panes.type === "leaf"
          ? { ...tab, exited: { code } }
          : { ...tab, exited: { code } }; // mark exited on the tab; pane shows the notice
      });
      return changed ? next : t;
    });
  }, []);

  const activeTab = tabs.find((t) => t.key === active) ?? null;

  // Menu-driven edit actions go to the focused pane of the active tab.
  const dispatchEdit = useCallback(
    (action: string) => {
      const tabKey = activeRef.current;
      const tab = tabsRef.current.find((t) => t.key === tabKey);
      if (!tab) return;
      let h = handles.current.get(tab.focusedPane);
      // Copy targets the pane with the FRESHEST selection, not keyboard focus:
      // after a split, focus sits in the newest pane while the user drags in
      // another. Falling back to "any selection" can grab a stale one; the
      // timestamp picks the one the user actually made.
      if (action === "copy") {
        const tsMap = (window as unknown as { __GT_SEL_TS?: Map<number, number> }).__GT_SEL_TS;
        let best: { id: number; ts: number } | null = null;
        for (const paneId of leafIds(tab.panes)) {
          const cand = handles.current.get(paneId);
          const ts = tsMap?.get(paneId) ?? 0;
          if (cand?.hasSelection() && ts > (best?.ts ?? 0)) best = { id: paneId, ts };
        }
        if (best) h = handles.current.get(best.id) ?? h;
      }
      if (!h) return;
      if (action === "copy") h.copy();
      else if (action === "paste") h.paste();
      else if (action === "selectAll") h.selectAll();
      else if (action === "clear") h.clear();
    },
    [],
  );

  // Boot: menus, hosts, restore-or-fresh tab.
  useEffect(() => {
    window.terminal.listShells().then((s) => setShells(s as never));
    window.terminal.sshHosts().then(setHosts).catch(() => {});
    window.terminal.onMenuNewTab(() => newTab());
    window.terminal.onMenuCloseTab(() => closeTab(activeRef.current));
    window.terminal.onMenuSplitH(() => splitPane("h"));
    window.terminal.onMenuSplitV(() => splitPane("v"));
    window.terminal.onMenuEdit(dispatchEdit);
    (async () => {
      const saved = await window.terminal.stateLoad();
      let restored = false;
      if (saved?.tabs?.length) {
        for (const st of saved.tabs.slice(0, 12)) {
          await newTab(st.shell === ("default" satisfies ShellKind) ? "default" : st.shell, st.host);
        }
        restored = true;
      }
      if (!restored) await newTab("default");
      booted.current = true;
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist layout (debounced).
  useEffect(() => {
    if (!booted.current) return;
    const timer = setTimeout(() => {
      window.terminal.stateSave({
        version: 1,
        tabs: tabs.map((t) => ({
          kind: t.kind,
          shell: t.shell,
          host: t.host,
          paneCount: leafIds(t.panes).length,
          splitDir: t.panes.type === "split" ? t.panes.dir : "h",
        })),
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [tabs]);

  const connect = async (host: string) => {
    setConnecting(host);
    await newTab("default", host);
    setConnecting(null);
  };

  return (
    <div className="app">
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
                    // Keep hidden tabs in the layout (visibility, not display)
                    // so xterm keeps valid glyph metrics; display:none is what
                    // corrupts the font atlas into "small squares".
                    style={t.key === active ? undefined : { visibility: "hidden" }}
                  >
                    <PaneTree
                      tab={t}
                      activeTabKey={active}
                      getSession={(paneId) => sessions.current.get(paneId) ?? null}
                      ensureSession={ensurePaneSession}
                      handles={handles.current}
                      onFocus={focusPane}
                      onSplit={splitPane}
                      onClosePane={closePane}
                      onExit={onExit}
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
const IS_MAC = navigator.userAgent.includes("Mac");
const TABBAR_PAD = IS_MAC ? 78 : 0;

function PaneTree({
  tab,
  activeTabKey,
  getSession,
  ensureSession,
  handles,
  onFocus,
  onSplit,
  onClosePane,
  onExit,
  onTitle,
}: {
  tab: Tab;
  activeTabKey: number | null;
  getSession: (paneId: number) => Session;
  ensureSession: (paneId: number, shell: ShellKind, host?: string) => void;
  handles: Map<number, PaneHandle>;
  onFocus: (tabKey: number, paneId: number) => void;
  onSplit: (dir: "h" | "v") => void;
  onClosePane: (paneId: number) => void;
  onExit: (paneId: number, sessionId: number, code: number) => void;
  onTitle: (title: string) => void;
}) {
  const render = (node: PaneNode): React.ReactNode => {
    if (node.type === "leaf") {
      return (
        <PaneFrame
          key={node.id}
          tab={tab}
          paneId={node.id}
          session={getSession(node.id)}
          focused={tab.focusedPane === node.id && activeTabKey === tab.key}
          ensureSession={ensureSession}
          handles={handles}
          onFocus={onFocus}
          onSplit={onSplit}
          onClosePane={onClosePane}
          onExit={onExit}
          onTitle={onTitle}
        />
      );
    }
    return (
      <div
        key={"split"}
        className={"split " + (node.dir === "h" ? "split-h" : "split-v")}
      >
        {node.children.map(render)}
      </div>
    );
  };
  return <div className="pane-tree">{render(tab.panes)}</div>;
}

function PaneFrame({
  tab,
  paneId,
  session,
  focused,
  ensureSession,
  handles,
  onFocus,
  onSplit,
  onClosePane,
  onExit,
  onTitle,
}: {
  tab: Tab;
  paneId: number;
  session: Session;
  focused: boolean;
  ensureSession: (paneId: number, shell: ShellKind, host?: string) => void;
  handles: Map<number, PaneHandle>;
  onFocus: (tabKey: number, paneId: number) => void;
  onSplit: (dir: "h" | "v") => void;
  onClosePane: (paneId: number) => void;
  onExit: (paneId: number, sessionId: number, code: number) => void;
  onTitle: (title: string) => void;
}) {
  const [hover, setHover] = useState(false);
  const isOnly = tab.panes.type === "leaf";

  useEffect(() => {
    ensureSession(paneId, tab.shell, tab.host);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId]);

  return (
    <div
      className={"pane-frame" + (focused ? " focused" : "") + (isOnly ? " only" : "")}
      onMouseDown={() => onFocus(tab.key, paneId)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {!isOnly && (
        <div className={"pane-bar" + (focused || hover ? "" : " dim")}>
          <button title="Split horizontally (Cmd+D)" onClick={() => { onFocus(tab.key, paneId); onSplit("h"); }}>◫</button>
          <button title="Split vertically (Cmd+Shift+D)" onClick={() => { onFocus(tab.key, paneId); onSplit("v"); }}>⊟</button>
          <span className="pane-bar-title">{tab.title}</span>
          <button title="Close pane" className="pane-close" onClick={() => onClosePane(paneId)}>×</button>
        </div>
      )}
      <div className="pane-term">
        <TerminalPane
          paneId={paneId}
          session={session}
          focused={focused}
          handles={handles}
          onExit={onExit}
          onTitle={onTitle}
        />
      </div>
    </div>
  );
}
