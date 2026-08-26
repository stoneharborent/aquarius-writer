import { useState } from "react";
import { Overlay } from "./Overlay";
import {
  ACCENTS,
  THEMES,
  THEME_LABEL,
  ACCENT_LABEL,
  themeLocksAccent,
} from "@/theme/theme";
import { useTheme } from "@/state/themeStore";
import { useVault } from "@/state/vaultStore";
import { PROVIDERS, useSync } from "@/state/syncStore";
import "./Settings.css";

type Tab = "appearance" | "sync" | "workflows" | "about";

export function Settings() {
  const [tab, setTab] = useState<Tab>("appearance");
  const { theme, accent, setTheme, setAccent } = useTheme();
  const [fontSize, setFontSize] = useState(17);
  const [lineHeight, setLineHeight] = useState(1.65);

  const workflows = useVault((s) => s.workflows);

  return (
    <Overlay title="Settings" width={720}>
      <div className="st">
        <nav className="st-nav">
          {(["appearance", "sync", "workflows", "about"] as Tab[]).map((t) => (
            <button
              key={t}
              className={`st-nav-btn${tab === t ? " active" : ""}`}
              onClick={() => setTab(t)}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
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
                      document.documentElement.style.setProperty("--prose-size", `${n}px`);
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
                      document.documentElement.style.setProperty("--prose-leading", String(n));
                    }}
                  />
                  <span className="st-slider-val">{lineHeight.toFixed(2)}</span>
                </label>
              </div>
            </>
          )}

          {tab === "sync" && <SyncTab />}

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
            <div className="st-section st-about">
              <h3>Aquarius Writer</h3>
              <div className="st-about-version">v0.0.1 · build phase 9</div>
              <p>
                Local-first writing studio. Free, no tiers, no telemetry. Files
                live on disk.
              </p>
              <p className="st-help">
                Stack: Tauri 2 · React 18 · TypeScript · CodeMirror 6 · pdf.js · Pandoc.
              </p>
            </div>
          )}
        </div>
      </div>
    </Overlay>
  );
}

function SyncTab() {
  const { folder, provider, setFolder, setProvider } = useSync();

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
