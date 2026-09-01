// The terminal pane — PARITY row 18, the last of Wave 3.
//
// What this is FOR: it is the other half of the MCP server. Settings already
// prints a `claude mcp add` line; this is where the writer runs `claude` so
// that line means something. Open the pane, type `claude` (or set it as the
// session's startup command and never type it again), and an external agent is
// driving the vault — in the app, in the workflow's own directory, with the
// manuscript open beside it. No embedded model, no second copy of the writer's
// files: bring your own agent.
//
// The Swift app's version (SWIFT-AUDIT §2.7) is SwiftTerm with named session
// tabs, a configurable agent command, the workflow's cwd, drag-a-file-for-its
// -path, and an adjustable font size. All five are here. Its pinning and its
// model/effort chip are not, because those describe an embedded agent this app
// deliberately does not have.
//
// The xterm instances themselves live in `registry.ts`, outside React — see
// the note at the top of that file for why.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CloseIcon, GearIcon, PlayIcon, PlusIcon } from "@/icons";
import { useTerminal, FONT_MAX, FONT_MIN } from "@/state/terminalStore";
import { useTheme } from "@/state/themeStore";
import { useVault } from "@/state/vaultStore";
import { ptyResolvePath } from "@/lib/pty";
import {
  dispose,
  ensureTerminal,
  getTerminal,
  launch,
  park,
  repaint,
  restart,
  safeFit,
  setFontSize,
  typePath,
} from "./registry";
import "@xterm/xterm/css/xterm.css";
import "./TerminalPane.css";

export function TerminalPane() {
  const current = useVault((s) => s.current);
  const workflows = useVault((s) => s.workflows);
  const sessions = useTerminal((s) => s.sessions);
  const activeId = useTerminal((s) => s.activeId);
  const runtime = useTerminal((s) => s.runtime);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [gearOpen, setGearOpen] = useState(false);

  // A pane with no tabs is not a state worth having. The first one is named
  // after the workflow, the way Swift names its default session.
  useEffect(() => {
    if (sessions.length === 0) useTerminal.getState().add(current?.title ?? "Terminal");
  }, [sessions.length, current?.title]);

  const active = sessions.find((s) => s.id === activeId) ?? sessions[0];
  const rt = active ? runtime[active.id] : undefined;

  /** The shell is somewhere the writer no longer is. */
  const strayIn = useMemo(() => {
    if (!active || !rt || rt.status !== "live") return null;
    if (!rt.workflowId || !current || rt.workflowId === current.id) return null;
    const name = workflows.find((w) => w.id === rt.workflowId)?.name;
    return name ?? rt.cwd.split("/").filter(Boolean).pop() ?? "another workflow";
  }, [active, rt, current, workflows]);

  const closeTab = (id: string) => {
    dispose(id);
    useTerminal.getState().close(id);
  };

  if (!active) return <div className="tm" />;

  return (
    <div className="tm">
      {/* The session strip. Comments / Versions / Terminal is the row above
          this one, drawn by RightPane — this row is only about sessions. */}
      <header className="tm-tabs">
        <div className="tm-tabstrip" role="tablist" aria-label="Terminal sessions">
          {sessions.map((s) => {
            const st = runtime[s.id]?.status ?? "idle";
            return (
              <div
                key={s.id}
                role="tab"
                aria-selected={s.id === active.id}
                className={`tm-tab${s.id === active.id ? " on" : ""}`}
                onClick={() => useTerminal.getState().setActive(s.id)}
                onDoubleClick={() => setRenaming(s.id)}
                title={`${s.name} — double-click to rename`}
              >
                <span className={`tm-dot tm-dot-${st}`} aria-hidden />
                {renaming === s.id ? (
                  <input
                    className="tm-rename"
                    defaultValue={s.name}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      useTerminal.getState().rename(s.id, e.currentTarget.value);
                      setRenaming(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") setRenaming(null);
                    }}
                  />
                ) : (
                  <span className="tm-tab-name">{s.name}</span>
                )}
                {sessions.length > 1 && (
                  <button
                    className="tm-tab-close"
                    title="Close this session"
                    aria-label={`Close ${s.name}`}
                    onClick={(e) => { e.stopPropagation(); closeTab(s.id); }}
                  >
                    <CloseIcon size={9} />
                  </button>
                )}
              </div>
            );
          })}
          <button
            className="tm-icon"
            title="New terminal session"
            aria-label="New terminal session"
            onClick={() => useTerminal.getState().add(current?.title ?? "Terminal")}
          >
            <PlusIcon size={11} />
          </button>
        </div>

        <span className="tm-spacer" />

        <div className="tm-font" role="group" aria-label="Terminal font size">
          <button
            className="tm-icon"
            title="Smaller text"
            disabled={active.fontSize <= FONT_MIN}
            onClick={() => useTerminal.getState().stepFont(active.id, -1)}
          >A−</button>
          <button
            className="tm-icon"
            title="Larger text"
            disabled={active.fontSize >= FONT_MAX}
            onClick={() => useTerminal.getState().stepFont(active.id, 1)}
          >A+</button>
        </div>

        <button
          className={`tm-icon${gearOpen ? " on" : ""}`}
          title="Startup command"
          aria-label="Startup command"
          aria-expanded={gearOpen}
          onClick={() => setGearOpen((v) => !v)}
        >
          <GearIcon size={13} />
        </button>
      </header>

      {gearOpen && (
        <StartupPanel
          id={active.id}
          startup={active.startup}
          onClose={() => setGearOpen(false)}
        />
      )}

      <div className="tm-status">
        <span className="tm-cwd" title={rt?.cwd || "not running"}>
          {rt?.cwd || (current ? current.title : "no workflow open")}
        </span>
        {rt?.status === "exited" && (
          <button
            className="tm-relaunch"
            onClick={() => void restart(active.id, current?.id ?? null, active.startup)}
          >
            <PlayIcon size={10} /> Relaunch
          </button>
        )}
        {strayIn && (
          <button
            className="tm-relaunch"
            title={`This shell is still in ${strayIn}. Restarting it here starts a new shell in ${current?.title}.`}
            onClick={() => void restart(active.id, current?.id ?? null, active.startup)}
          >
            in {strayIn} — restart here
          </button>
        )}
      </div>

      {rt?.error && <p className="tm-error">{rt.error}</p>}

      <div className="tm-bodies">
        {sessions.map((s) => (
          <TerminalView key={s.id} id={s.id} active={s.id === active.id} />
        ))}
      </div>
    </div>
  );
}

/**
 * The startup command.
 *
 * Typed into the shell on spawn rather than spawned instead of it, so `claude`
 * quitting drops you at a prompt in the right directory instead of killing the
 * tab. This value is executable — the store's note says why nothing else is
 * allowed to write it.
 */
function StartupPanel({ id, startup, onClose }: {
  id: string; startup: string; onClose: () => void;
}) {
  const [draft, setDraft] = useState(startup);
  const commit = () => {
    useTerminal.getState().setStartup(id, draft);
    onClose();
  };
  return (
    <div className="tm-gear">
      <label className="tm-gear-label" htmlFor={`tm-startup-${id}`}>
        Run on launch
      </label>
      <input
        id={`tm-startup-${id}`}
        className="tm-gear-input"
        value={draft}
        autoFocus
        spellCheck={false}
        placeholder="claude"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") onClose();
        }}
      />
      <p className="tm-gear-hint">
        Typed into the shell when the session starts. Leave it empty for a plain
        shell. It takes effect the next time this session launches.
      </p>
      <div className="tm-gear-row">
        <button className="tm-gear-btn" onClick={commit}>Save</button>
        <button className="tm-gear-btn ghost" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * One session's screen.
 *
 * The component owns none of the terminal: it borrows the element out of the
 * registry on mount and hands it back on unmount, so collapsing the pane costs
 * a DOM move and nothing else.
 */
function TerminalView({ id, active }: { id: string; active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const cfg = useTerminal((s) => s.sessions.find((x) => x.id === id));
  const status = useTerminal((s) => s.runtime[id]?.status);
  const workflowId = useVault((s) => s.current?.id ?? null);
  const theme = useTheme((s) => s.theme);
  const accent = useTheme((s) => s.accent);
  const [dropping, setDropping] = useState(false);

  const fontSize = cfg?.fontSize ?? 12;
  const startup = cfg?.startup ?? "";

  useEffect(() => {
    const entry = ensureTerminal(id, fontSize);
    const el = host.current;
    el?.appendChild(entry.el);
    safeFit(id);
    let ro: ResizeObserver | undefined;
    if (el && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => safeFit(id));
      ro.observe(el);
    }
    return () => {
      ro?.disconnect();
      // Hand the element back to the parking lot but leave the Terminal alive
      // — see registry.ts. Only closing the tab disposes it.
      park(id);
    };
    // `fontSize` is only the value used at creation; the effect below tracks it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => { setFontSize(id, fontSize); }, [id, fontSize]);
  useEffect(() => { repaint(id); }, [id, theme, accent]);

  useEffect(() => {
    if (!active) return;
    safeFit(id);
    getTerminal(id)?.term.focus();
  }, [active, id]);

  // Launch lazily, and only for the tab being looked at: a writer with four
  // saved tabs should not get four shells on the first open of the pane.
  useEffect(() => {
    if (!active) return;
    if (status && status !== "idle") return;
    void launch(id, workflowId, startup);
  }, [active, id, status, workflowId, startup]);

  /**
   * A file dragged out of the sidebar writes its absolute path.
   *
   * The tree's drag payload is already `text/plain` with the vault-relative
   * path (Sidebar.tsx), so nothing had to be coordinated: this side reads it,
   * asks Rust for the absolute form — which is also the path-safety check —
   * and types it at the cursor with a trailing space, ready for a command in
   * front of it.
   */
  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropping(false);
    const raw = e.dataTransfer.getData("text/plain").trim();
    if (!raw) return;
    if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
      typePath(id, raw);
      return;
    }
    if (!workflowId) return;
    try {
      typePath(id, await ptyResolvePath(workflowId, raw));
    } catch {
      /* a path the vault will not resolve is not typed, and says nothing —
         the ring going away is the whole answer a drop needs */
    }
  }, [id, workflowId]);

  return (
    <div
      ref={host}
      className={`tm-body${active ? "" : " tm-hidden"}${dropping ? " tm-dropping" : ""}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("text/plain")) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDropping(false);
      }}
      onDrop={(e) => { void onDrop(e); }}
    />
  );
}
