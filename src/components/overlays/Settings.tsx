import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Overlay } from "./Overlay";
import { isTauriShell } from "@/lib/platform";
import {
  ACCENTS,
  THEMES,
  THEME_LABEL,
  ACCENT_LABEL,
  applyProseMetrics,
  themeLocksAccent,
} from "@/theme/theme";
import { useTheme } from "@/state/themeStore";
import { useVault } from "@/state/vaultStore";
import { useOverlay } from "@/state/overlayStore";
import { PROVIDERS, useSync } from "@/state/syncStore";
import { useUpdates } from "@/state/updateStore";
import "./Settings.css";

type Tab = "appearance" | "sync" | "workflows" | "mcp" | "about";

const TABS: Tab[] = ["appearance", "sync", "workflows", "mcp", "about"];

export function Settings() {
  // The caller may name the tab it wants — the sidebar's "Manage workflows…"
  // opens straight onto Workflows. Read once, as the initial value, so the
  // writer can then move around freely.
  const wanted = useOverlay((s) => s.payload.tab);
  const [tab, setTab] = useState<Tab>(
    TABS.includes(wanted as Tab) ? (wanted as Tab) : "appearance",
  );
  const theme = useTheme((s) => s.theme);
  const accent = useTheme((s) => s.accent);
  const setTheme = useTheme((s) => s.setTheme);
  const setAccent = useTheme((s) => s.setAccent);
  const [fontSize, setFontSize] = useState(17);
  const [lineHeight, setLineHeight] = useState(1.65);

  const workflows = useVault((s) => s.workflows);

  return (
    <Overlay title="Settings" width={720}>
      <div className="st">
        <nav className="st-nav">
          {TABS.map((t) => (
            <button
              key={t}
              className={`st-nav-btn${tab === t ? " active" : ""}`}
              onClick={() => setTab(t)}
            >
              {t === "mcp" ? "MCP" : t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>

        <div className="st-body">
          {tab === "appearance" && (
            <>
              <div className="st-section">
                <h3>Theme</h3>
                <div className="st-row">
                  {THEMES.map((t) => (
                    <button
                      key={t}
                      className={`st-chip${theme === t ? " active" : ""}`}
                      onClick={() => setTheme(t)}
                    >{THEME_LABEL[t]}</button>
                  ))}
                </div>
                {theme === "aquarius" && (
                  <p className="st-help">
                    The operating system's own skin — void black, starlight
                    blue. It's the default on AquariusOS; the writing page stays
                    a calmer surface than the chrome around it.
                  </p>
                )}
              </div>

              {/* The accent is part of the OS identity under AquariusOS —
                  starlight and nothing else — so there is no picker for it. */}
              {!themeLocksAccent(theme) && (
                <div className="st-section">
                  <h3>Accent</h3>
                  <div className="st-row">
                    {ACCENTS.map((a) => (
                      <button
                        key={a}
                        className={`st-chip st-chip-accent${accent === a ? " active" : ""}`}
                        data-accent={a}
                        onClick={() => setAccent(a)}
                      >
                        <span className="st-chip-swatch" />
                        {ACCENT_LABEL[a]}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Both sliders go through `applyProseMetrics`, which rounds the
                  size × leading product to a whole-pixel line box before it
                  reaches the editor. Writing `--prose-size` or
                  `--prose-leading` directly from here is what shipped the
                  fractional 28.05px line box in v0.3.0 — see NOTES §1a. */}
              <div className="st-section">
                <h3>Reading</h3>
                <label className="st-slider">
                  <span>Body size</span>
                  <input
                    type="range" min={14} max={22} step={1}
                    value={fontSize}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      setFontSize(n);
                      applyProseMetrics(n, lineHeight);
                    }}
                  />
                  <span className="st-slider-val">{fontSize}px</span>
                </label>
                <label className="st-slider">
                  <span>Line height</span>
                  <input
                    type="range" min={13} max={20} step={1}
                    value={lineHeight * 10}
                    onChange={(e) => {
                      const n = Number(e.target.value) / 10;
                      setLineHeight(n);
                      applyProseMetrics(fontSize, n);
                    }}
                  />
                  <span className="st-slider-val">
                    {lineHeight.toFixed(2)} · {Math.round(fontSize * lineHeight)}px
                  </span>
                </label>
              </div>
            </>
          )}

          {tab === "sync" && <SyncTab />}

          {tab === "mcp" && <McpTab />}

          {tab === "workflows" && (
            <>
              <div className="st-section">
                <h3>Connected workflows</h3>
                <ul className="st-wf">
                  {workflows.map((w) => (
                    <li key={w.id}>
                      <span className="st-wf-name">{w.name}</span>
                      <span className="st-wf-path">{w.path}</span>
                      <span className="st-wf-meta">{w.items} items · {w.updated}</span>
                    </li>
                  ))}
                </ul>
                <button className="st-chip">+ Add workflow…</button>
              </div>
            </>
          )}

          {tab === "about" && (
            <>
              <div className="st-section st-about">
                <h3>Aquarius Writer</h3>
                <div className="st-about-version">v{__APP_VERSION__}</div>
                <p>
                  Local-first writing studio. Free, no tiers, no telemetry. Files
                  live on disk.
                </p>
                <p className="st-help">
                  Stack: Tauri 2 · React 18 · TypeScript · CodeMirror 6 · pdf.js · Pandoc.
                </p>
              </div>
              <UpdatesSection />
            </>
          )}
        </div>
      </div>
    </Overlay>
  );
}

/**
 * The Updates section of the About tab — AquariusOS only.
 *
 * On AquariusOS this app is part of the operating system, which is read-only,
 * so it cannot replace itself. It downloads a newer copy into a folder in the
 * home directory instead, and the OS starts whichever copy is newer. All of
 * that happens in Rust; this is one row of text and one button, whose wording
 * follows whatever phase the backend reports.
 *
 * Everywhere else — the Mac build, the browser preview, a Linux machine where
 * the app was started by hand — `osManaged` is false and this renders nothing.
 * Those copies are updated the way they were installed.
 */
function UpdatesSection() {
  const status = useUpdates((s) => s.status);
  const check = useUpdates((s) => s.check);
  const install = useUpdates((s) => s.install);
  const restart = useUpdates((s) => s.restart);

  if (!status?.osManaged) return null;

  const { phase, latestVersion, percent, message, failedOperation } = status;
  const busy = phase === "checking" || phase === "downloading" || phase === "installing";
  // Once a version is installed and waiting, asking GitHub again could only
  // replace the restart button with a download button for what is already
  // downloaded. The backend refuses it; the button says so.
  const canCheck = !busy && phase !== "ready";

  // One sentence per phase, in the order they happen.
  const line = (() => {
    switch (phase) {
      case "checking":
        return "Looking for a newer version…";
      case "current":
        return "You have the newest version.";
      case "available":
        return `Version ${latestVersion} is available.`;
      case "downloading":
        return `Downloading version ${latestVersion}… ${percent ?? 0}%`;
      case "installing":
        return "Installing — this takes a moment. Don't close the app.";
      case "ready":
        return `Version ${latestVersion} is installed. Restart to start using it.`;
      case "error":
        return message ?? "That didn't work.";
      default:
        return "Aquarius Writer came with AquariusOS and can update itself.";
    }
  })();

  return (
    <div className="st-section">
      <h3>Updates</h3>
      <div className="st-row st-update-row">
        <span className={`st-dot${busy ? " live" : ""}`} />
        <span className={phase === "error" ? "st-warn" : undefined}>{line}</span>
      </div>

      {phase === "downloading" && (
        <div
          className="st-progress"
          role="progressbar"
          aria-valuenow={percent ?? 0}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span style={{ width: `${percent ?? 0}%` }} />
        </div>
      )}

      <div className="st-row">
        {phase === "available" && (
          <button className="st-chip active" onClick={() => void install()}>
            Download and install
          </button>
        )}
        {phase === "ready" && (
          <button className="st-chip active" onClick={() => void restart()}>
            Restart to update
          </button>
        )}
        {/* A failed download is retried by downloading again. A failed *check*
            is retried by the Check button below, which is always there — so
            this only appears for the one it fits. */}
        {phase === "error" && failedOperation === "install" && (
          <button className="st-chip active" onClick={() => void install()}>
            Try again
          </button>
        )}
        <button className="st-chip" disabled={!canCheck} onClick={() => void check()}>
          Check for updates
        </button>
      </div>

      <p className="st-help">
        The download is checked against the release's checksum before anything is
        installed, and the copy built into AquariusOS is never touched — so if an
        update fails, you carry on with the version you already have.
      </p>
    </div>
  );
}

/**
 * The MCP server tab.
 *
 * Aquarius Writer has no AI of its own — Stage 5 removed the embedded agent on
 * purpose. This is the replacement: turn the switch on and the app speaks MCP
 * on localhost, so Claude Code (or any other MCP client) can read and edit the
 * vault with the same operations a human has here.
 *
 * All the state lives in Rust. This panel only reads `mcp_status` and asks for
 * changes, so the switch can never disagree with what is actually listening.
 */
function McpTab() {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [portDraft, setPortDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const inShell = isTauriShell();

  const apply = useCallback(async (call: Promise<McpStatus>) => {
    setBusy(true);
    setProblem(null);
    try {
      const next = await call;
      setStatus(next);
      setPortDraft(String(next.port));
    } catch (e) {
      setProblem(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!inShell) return;
    void apply(invoke<McpStatus>("mcp_status"));
  }, [inShell, apply]);

  if (!inShell) {
    return (
      <div className="st-section">
        <h3>MCP server</h3>
        <p className="st-help">
          The MCP server runs in the desktop app. This is the browser preview,
          which has no vault and no listener — open Aquarius Writer itself to
          switch it on.
        </p>
      </div>
    );
  }

  const on = status?.enabled ?? false;

  return (
    <>
      <div className="st-section">
        <h3>MCP server</h3>
        <p className="st-help">
          Lets an outside AI app — Claude Code, Claude Desktop — read and edit
          your vaults: everything you can do here, it can do too. The server
          listens on this machine only (127.0.0.1) and is off until you turn it
          on.
        </p>
        <div className="st-row">
          <label className="st-switch">
            <input
              type="checkbox"
              checked={on}
              disabled={busy}
              onChange={(e) =>
                void apply(invoke<McpStatus>("mcp_set_enabled", { enabled: e.target.checked }))
              }
            />
            <span>{on ? "On" : "Off"}</span>
          </label>
          {status && (
            <span className={`st-dot${status.running ? " live" : ""}`}>
              {status.running ? "listening" : "not listening"}
            </span>
          )}
        </div>
        {status?.error && <p className="st-warn">Could not start: {status.error}</p>}
        {problem && <p className="st-warn">{problem}</p>}
      </div>

      {on && status && (
        <div className="st-section">
          <h3>Connect Claude Code</h3>
          <p className="st-help">
            Run this once in a terminal — including the app's own, in the right
            pane (⇧⌘J), which already opens in the workflow's folder. Claude
            Code remembers it; the app has to be running for the connection to
            work.
          </p>
          <div className="st-row">
            <code className="st-code">{status.claudeCommand}</code>
            <button
              className="st-chip"
              onClick={() => {
                void navigator.clipboard?.writeText(status.claudeCommand).then(
                  () => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1600);
                  },
                  () => setProblem("The clipboard is not available here — select the line and copy it."),
                );
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="st-help">
            Other clients want the URL on its own: <code className="st-code-inline">{status.url}</code>
          </p>
        </div>
      )}

      <div className="st-section">
        <h3>Port</h3>
        <p className="st-help">
          Change this only if something else on your machine already uses{" "}
          {status?.port ?? 1729}. Changing it while the server is on restarts it,
          and any client you already connected needs the new URL.
        </p>
        <div className="st-row">
          <input
            className="st-input st-input-narrow"
            type="number"
            min={1024}
            max={65535}
            value={portDraft}
            disabled={busy}
            onChange={(e) => setPortDraft(e.target.value)}
            spellCheck={false}
          />
          <button
            className="st-chip"
            disabled={busy || portDraft === String(status?.port ?? "")}
            onClick={() => {
              const port = Number(portDraft);
              if (!Number.isInteger(port) || port < 1024 || port > 65535) {
                setProblem("Pick a whole number between 1024 and 65535.");
                return;
              }
              void apply(invoke<McpStatus>("mcp_set_port", { port }));
            }}
          >
            Use this port
          </button>
        </div>
      </div>

      <div className="st-section">
        <h3>What it can reach</h3>
        <p className="st-help">
          Every vault in your workflow list, not just the one open here — a
          client names the vault it wants. It can create, read, rewrite,
          re-order and trash documents. Deleting is the same soft delete the app
          uses: files go to Recently Deleted and can be restored for 30 days.
          There is no way for a client to delete anything permanently. There is
          no password on the connection, because nothing outside this machine
          can reach the port.
        </p>
      </div>
    </>
  );
}

/** Mirrors `McpStatus` in `src-tauri/src/mcp/mod.rs`. */
interface McpStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  url: string;
  claudeCommand: string;
  error?: string;
}

function SyncTab() {
  const folder = useSync((s) => s.folder);
  const provider = useSync((s) => s.provider);
  const setFolder = useSync((s) => s.setFolder);
  const setProvider = useSync((s) => s.setProvider);

  return (
    <>
      <div className="st-section">
        <h3>Folder sync</h3>
        <p className="st-help">
          Aquarius doesn't ship a sync engine — point it at a folder, and your
          OS sync handles the wire. Same files, any machine.
        </p>
        <div className="st-row">
          <input
            className="st-input"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            spellCheck={false}
          />
          <button className="st-chip" onClick={() => alert("Folder picker is wired in the Tauri shell.")}>
            Browse…
          </button>
        </div>
      </div>

      <div className="st-section">
        <h3>Provider</h3>
        <div className="sy-providers">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              className={`sy-card${provider === p.id ? " active" : ""}`}
              onClick={() => setProvider(p.id)}
            >
              <span className="sy-name">{p.name}</span>
              <span className="sy-hint">{p.hint}</span>
              {provider === p.id && <span className="sy-active-dot" />}
            </button>
          ))}
        </div>
      </div>

      <div className="st-section">
        <h3>What happens on conflict</h3>
        <p className="st-help">
          Aquarius checks file mtime + content hash before every save. If
          another process changed the file while you were editing, the conflict
          dialog opens with both versions side-by-side — pick which to keep.
          No silent overwrites.
        </p>
      </div>
    </>
  );
}
