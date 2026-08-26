import { useState } from "react";
import { Overlay } from "./Overlay";
import {
  ACCENTS,
  AccentName,
  applyTheme,
  readTheme,
  THEMES,
  ThemeName,
  ACCENT_LABEL,
} from "@/theme/theme";
import { useVault } from "@/state/vaultStore";
import { PROVIDERS, useSync } from "@/state/syncStore";
import { useLicense } from "@/state/licenseStore";
import "./Settings.css";
import "@/components/pricing/Pricing.css";

type Tab = "appearance" | "sync" | "workflows" | "pricing" | "about";

export function Settings() {
  const [tab, setTab] = useState<Tab>("appearance");
  const initial = readTheme();
  const [theme, setTheme] = useState<ThemeName>(initial.theme);
  const [accent, setAccent] = useState<AccentName>(initial.accent);
  const [fontSize, setFontSize] = useState(17);
  const [lineHeight, setLineHeight] = useState(1.65);

  const workflows = useVault((s) => s.workflows);

  function applyThemeNow(t: ThemeName, a: AccentName) {
    setTheme(t); setAccent(a); applyTheme(t, a);
  }

  return (
    <Overlay title="Settings" width={720}>
      <div className="st">
        <nav className="st-nav">
          {(["appearance", "sync", "workflows", "pricing", "about"] as Tab[]).map((t) => (
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
                      onClick={() => applyThemeNow(t, accent)}
                    >{t}</button>
                  ))}
                </div>
              </div>

              <div className="st-section">
                <h3>Accent</h3>
                <div className="st-row">
                  {ACCENTS.map((a) => (
                    <button
                      key={a}
                      className={`st-chip st-chip-accent${accent === a ? " active" : ""}`}
                      data-accent={a}
                      onClick={() => applyThemeNow(theme, a)}
                    >
                      <span className="st-chip-swatch" />
                      {ACCENT_LABEL[a]}
                    </button>
                  ))}
                </div>
              </div>

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

          {tab === "pricing" && <PricingTab />}

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
              <p>Local-first writing studio. No telemetry. Files live on disk.</p>
              <p className="st-help">
                Stack: Tauri 2 · React 18 · TypeScript · CodeMirror 6 · pdf.js · Ollama · Pandoc.
              </p>
            </div>
          )}
        </div>
      </div>
    </Overlay>
  );
}

function PricingTab() {
  const license = useLicense();

  return (
    <>
      <div className="st-section">
        <h3>Your tier</h3>
        <div className="pr-current">
          <span className="pr-current-tier">
            {license.base}{license.spark ? " · Spark" : ""}
          </span>
          <span className="pr-current-detail">
            {license.base === "studio"
              ? "Studio · the whole writing toolkit, paid once."
              : "Notes · free forever. Markdown editor, themes, graph, terminal, markdown/PDF export."}
            {license.spark && " Spark add-on enabled — local AI runs on this machine."}
          </span>
        </div>
      </div>

      <div className="st-section">
        <h3>All tiers</h3>
        <div className="pr-grid">
          <article className={`pr-card${license.base === "notes" && !license.spark ? " active" : ""}`}>
            <div className="pr-name">Notes</div>
            <div className="pr-price">Free forever</div>
            <ul className="pr-perks">
              <li>Markdown editor + WYSIWYG</li>
              <li>Themes (Parchment / Midnight)</li>
              <li>Graph view + search</li>
              <li>Terminal pane (BYO CLI agent)</li>
              <li>Markdown + PDF export</li>
            </ul>
            {license.base === "studio" && (
              <button className="pr-action ghost" onClick={() => license.downgradeToNotes()}>
                Downgrade
              </button>
            )}
          </article>

          <article className={`pr-card${license.base === "studio" ? " active" : ""}`}>
            <span className="pr-tag">Recommended</span>
            <div className="pr-name">Studio</div>
            <div className="pr-price">$50 once</div>
            <ul className="pr-perks">
              <li>Everything in Notes</li>
              <li>Manuscript outline + corkboard</li>
              <li>Screenplay editor (Fountain) + scenes rail</li>
              <li>Chapter rail inside the prose editor</li>
              <li>EPUB · Word · FDX · PDF export</li>
              <li>All future writing tools</li>
            </ul>
            {license.base !== "studio" && (
              <button className="pr-action" onClick={() => license.upgradeToStudio()}>
                Unlock · $50
              </button>
            )}
          </article>

          <article className={`pr-card${license.spark ? " active" : ""}`}>
            <div className="pr-name">Spark</div>
            <div className="pr-price">$5/mo add-on</div>
            <ul className="pr-perks">
              <li>Local AI writing companion</li>
              <li>Bundled model, runs offline</li>
              <li>Persona presets</li>
              <li>No API keys, no telemetry</li>
              <li>Works on Notes or Studio</li>
            </ul>
            {!license.spark ? (
              <button className="pr-action" disabled title="Spark ships in a later web phase">
                Set up Spark
              </button>
            ) : (
              <button className="pr-action ghost" onClick={() => license.disableSpark()}>
                Disable
              </button>
            )}
          </article>
        </div>
      </div>

      <div className="st-section">
        <h3>Fine print</h3>
        <p className="st-help">
          Studio is a one-time purchase, tied to your machine but transferable.
          Spark is $5/month and can be paused anytime — the model on disk stays
          yours. There's no enterprise tier and no per-seat pricing; if you're
          a team, every writer buys their own copy.
        </p>
      </div>
    </>
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
