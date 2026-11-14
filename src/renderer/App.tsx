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

const HOST_COLORS = ["#61afef", "#77c07a", "#c678dd", "#e5c07b", "#56b6c2", "#e06c75"];
function hostColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return HOST_COLORS[h % HOST_COLORS.length];
}
function hostInitials(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9]/g, " ").trim();
  const parts = clean.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return clean.slice(0, 2).toUpperCase();
}

export function App() {
  const [shells, setShells] = useState<{ kind: string; label: string }[]>([]);
  const [hosts, setHosts] = useState<{ host: string; hostname?: string; user?: string }[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [search, setSearch] = useState<{ open: boolean; query: string }>({ open: false, query: "" });

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

  const newTab = useCallback(async (shell: ShellKind = "default", host?: string) => {
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
  }, []);

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
    void sessionId;
    setTabs((t) => {
      let changed = false;
      const next = t.map((tab) => {
        const paneStillThere = leafIds(tab.panes).includes(paneId);
        if (!paneStillThere) return tab;
        changed = true;
        return { ...tab, exited: { code } };
      });
      return changed ? next : t;
    });
  }, []);

  const activeTab = tabs.find((t) => t.key === active) ?? null;

  // Menu-driven edit actions go to the focused pane of the active tab.
  const dispatchEdit = useCallback((action: string) => {
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
    else if (action === "find") setSearch((s) => ({ ...s, open: true }));
  }, []);

  // Boot: menus, hosts, restore-or-fresh tab.
  useEffect(() => {
    window.terminal.listShells().then((s) => setShells(s as never));
    window.terminal.sshHosts().then(setHosts).catch(() => {});
    window.terminal.onMenuNewTab(() => newTab());
    window.terminal.onMenuCloseTab(() => closeTab(activeRef.current));
    window.terminal.onMenuSplitH(() => splitPane("h"));
    window.terminal.onMenuSplitV(() => splitPane("v"));
    window.terminal.onMenuEdit(dispatchEdit);
    window.terminal.onMenuSelectTab((n) => {
      const t = tabsRef.current;
      if (n >= 0 && n < t.length) setActive(t[n].key);
    });
    window.terminal.onMenuNextTab(() => {
      const t = tabsRef.current;
      if (!t.length) return;
      const idx = t.findIndex((x) => x.key === activeRef.current);
      setActive(t[(idx + 1) % t.length].key);
    });
    (async () => {
      const saved = await window.terminal.stateLoad();
      let restored = false;
      if (saved?.tabs?.length) {
        for (const st of saved.tabs.slice(0, 12)) {
          await newTab(st.shell, st.host);
        }
        restored = true;
      }
      if (!restored) await newTab("default");
      booted.current = true;
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Route find-bar events to the focused pane's search addon.
  useEffect(() => {
    const pane = () => {
      const tab = tabsRef.current.find((t) => t.key === activeRef.current);
      return tab ? handles.current.get(tab.focusedPane) : undefined;
    };
    const onSearch = (e: Event) => pane()?.findNext((e as CustomEvent).detail as string);
    const onNext = () => pane()?.findNext(searchQuery.current);
    const onPrev = () => pane()?.findPrev(searchQuery.current);
    window.addEventListener("gt-search", onSearch);
    window.addEventListener("gt-search-next", onNext);
    window.addEventListener("gt-search-prev", onPrev);
    return () => {
      window.removeEventListener("gt-search", onSearch);
      window.removeEventListener("gt-search-next", onNext);
      window.removeEventListener("gt-search-prev", onPrev);
    };
  }, []);
  const searchQuery = useRef("");

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

  useEffect(() => {
    searchQuery.current = search.query;
  }, [search.query]);

  const connect = async (host: string) => {
    setConnecting(host);
    await newTab("default", host);
    setConnecting(null);
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-title">
          <span className="logo-mark">▚</span>
          <span className="logo-name">GuiTerminal</span>
        </div>

        <div className="side-scroll">
          <div className="section-label">Local</div>
          {shells.map((s) => (
            <button key={s.kind} className="side-item" onClick={() => newTab(s.kind as ShellKind)}>
              <span className="side-ico">$</span>
              <span>{s.label}</span>
              <span className="side-plus">+</span>
            </button>
          ))}

          <div className="section-label section-gap">SSH</div>
          {hosts.length === 0 && <div className="side-hint">No hosts in ~/.ssh/config</div>}
          {hosts.map((h) => (
            <button
              key={h.host}
              className="side-item"
              disabled={connecting !== null}
              onClick={() => connect(h.host)}
              title={h.hostname ? `${h.user ? h.user + "@" : ""}${h.hostname}` : h.host}
            >
              <span className="host-badge" style={{ background: hostColor(h.host) }}>
                {hostInitials(h.host)}
              </span>
              <span className="host-name">{h.host}</span>
              {connecting === h.host ? (
                <span className="connecting">…</span>
              ) : (
                <span className="side-plus">+</span>
              )}
            </button>
          ))}
        </div>

        <div className="sidebar-footer">
          <span className="muted">v{APP_VERSION}</span>
        </div>
      </aside>

      <main className="main">
        {tabs.length === 0 ? (
          <div className="empty">
            <div className="empty-logo">▚</div>
            <div className="empty-hint">⌘T new tab · ⌘D split · drag to select · ⌘C copy</div>
          </div>
        ) : (
          <>
            <div className="tabbar">
              <div className="tabs-scroll" style={{ paddingLeft: TABBAR_PAD }}>
                {tabs.map((t, i) => (
                  <div
                    key={t.key}
                    className={"tab" + (t.key === active ? " active" : "")}
                    onClick={() => setActive(t.key)}
                  >
                    <span
                      className={"tab-dot " + (t.kind === "ssh" ? "ssh" : "local")}
                      style={t.kind === "ssh" && t.host ? { background: hostColor(t.host) } : undefined}
                    />
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
                    {i < 9 && <span className="tab-num">{i + 1}</span>}
                  </div>
                ))}
                <button className="tab-new" title="New Tab (Cmd+T)" onClick={() => newTab()}>
                  +
                </button>
              </div>
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

            {activeTab && (
              <div className="statusbar">
                <span className="statusbar-cell">
                  {leafIds(activeTab.panes).length === 1
                    ? "1 pane"
                    : `${leafIds(activeTab.panes).length} panes`}
                </span>
                <span className="statusbar-sep" />
                <span className="statusbar-cell">
                  {activeTab.kind === "ssh" ? activeTab.host : activeTab.title}
                </span>
                <span className="statusbar-sep" />
                <button
                  className="statusbar-btn"
                  onClick={() => setSearch((s) => ({ ...s, open: true }))}
                >
                  Find ⌘F
                </button>
              </div>
            )}
          </>
        )}
      </main>

      {search.open && (
        <SearchBar
          query={search.query}
          onChange={(q) => setSearch((s) => ({ ...s, query: q }))}
          onClose={() => {
            setSearch({ open: false, query: "" });
            const tab = tabsRef.current.find((t) => t.key === activeRef.current);
            if (tab) handles.current.get(tab.focusedPane)?.findHide();
          }}
        />
      )}
    </div>
  );
}

declare const APP_VERSION: string;
const IS_MAC = navigator.userAgent.includes("Mac");
const TABBAR_PAD = IS_MAC ? 78 : 0;

/** Floating find bar (Cmd+F) — delegates to the focused pane's search addon. */
function SearchBar({
  query,
  onChange,
  onClose,
}: {
  query: string;
  onChange: (q: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [count, setCount] = useState<{ resultIndex: number; matchIndex: number } | null>(null);

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    const onCount = (e: Event) => {
      const d = (e as CustomEvent).detail as { matchIndex: number; resultIndex: number };
      setCount({ resultIndex: d.resultIndex, matchIndex: d.matchIndex });
    };
    window.addEventListener("gt-search-result", onCount);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("gt-search-result", onCount);
    };
  }, [onClose]);

  // Live search as you type (debounced).
  useEffect(() => {
    const timer = setTimeout(() => {
      if (query) window.dispatchEvent(new CustomEvent("gt-search", { detail: query }));
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  return (
    <div className="find-bar">
      <span className="find-icon">⌕</span>
      <input
        ref={ref}
        value={query}
        placeholder="Find in terminal…"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            window.dispatchEvent(new CustomEvent(e.shiftKey ? "gt-search-prev" : "gt-search-next"));
          }
        }}
      />
      <span className="find-count">
        {count ? `${count.resultIndex}/${count.matchIndex}` : query ? "…" : ""}
      </span>
      <button
        className="find-btn"
        title="Previous (Shift+Enter)"
        onClick={() => window.dispatchEvent(new CustomEvent("gt-search-prev"))}
      >
        ↑
      </button>
      <button
        className="find-btn"
        title="Next (Enter)"
        onClick={() => window.dispatchEvent(new CustomEvent("gt-search-next"))}
      >
        ↓
      </button>
      <button className="find-btn find-close" title="Close (Esc)" onClick={onClose}>
        ×
      </button>
    </div>
  );
}

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
      <div key={"split"} className={"split " + (node.dir === "h" ? "split-h" : "split-v")}>
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
          <button title="Split right (Cmd+D)" onClick={() => { onFocus(tab.key, paneId); onSplit("h"); }}>◫</button>
          <button title="Split down (Cmd+Shift+D)" onClick={() => { onFocus(tab.key, paneId); onSplit("v"); }}>⊟</button>
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
