import { useEffect, useState } from "react";
import { Overlay } from "@/components/overlays/Overlay";
import { useLicense } from "@/state/licenseStore";
import { useOverlay } from "@/state/overlayStore";
import { CheckIcon, SparkleIcon } from "@/icons";
import "./Pricing.css";

const PERSONAS = [
  { id: "companion",   name: "Companion",   mood: "Warm, encouraging, asks one question at a time." },
  { id: "editor",      name: "Editor",      mood: "Sharp and economical. Cuts adverbs, names hedges." },
  { id: "outliner",    name: "Outliner",    mood: "Structural. Sees the shape of the scene before the prose." },
  { id: "sparring",    name: "Sparring partner", mood: "Pushes back. Asks if the protagonist actually wants what they say they want." },
  { id: "researcher",  name: "Researcher",  mood: "Quiet, factual. Hands you the source on the table." },
  { id: "minimalist",  name: "Minimalist",  mood: "One sentence at a time. No filler. No preamble." },
];

// Synthetic model fixture — real flow downloads from the catalog.
const MODEL_TOTAL = 4_200_000_000;
const MODEL_HASH  = "sha256:f3d8c1e9b2a47f1c5e83d9b6c2718a4d";

export function SparkSetup() {
  const { sparkReady, markSparkReady, enableSpark } = useLicense();
  const closeOverlay = useOverlay((s) => s.close);
  const [downloaded, setDownloaded] = useState(0);
  const [verified, setVerified] = useState(false);
  const [persona, setPersona] = useState<string | null>(null);

  useEffect(() => {
    if (sparkReady) return;
    let cancelled = false;
    const interval = setInterval(() => {
      if (cancelled) return;
      setDownloaded((d) => {
        const next = d + 220_000_000;
        if (next >= MODEL_TOTAL) {
          clearInterval(interval);
          setTimeout(() => !cancelled && setVerified(true), 600);
          return MODEL_TOTAL;
        }
        return next;
      });
    }, 200);
    return () => { cancelled = true; clearInterval(interval); };
  }, [sparkReady]);

  const downloadPct = Math.min(1, downloaded / MODEL_TOTAL);
  const downloadDone = downloaded >= MODEL_TOTAL;

  function finish() {
    if (!persona) return;
    enableSpark();
    markSparkReady();
    closeOverlay();
  }

  return (
    <Overlay title="" width={620} onClose={closeOverlay}>
      <div className="sp">
        <div className="ul-eyebrow">
          <SparkleIcon size={14} color="var(--accent)" />
          <span>Spark · local AI · $5/mo</span>
        </div>

        <h2 className="ul-title">Set up your writing companion</h2>
        <p className="ul-sub">
          Spark runs entirely on this machine — no API keys, no cloud round-trips,
          no telemetry. The model is bundled; we just need to download it once.
        </p>

        {/* Step 1: download */}
        <div className="sp-step">
          <div className={`sp-step-num ${downloadDone && verified ? "done" : ""}`}>1</div>
          <div className="sp-step-body">
            <div className="sp-step-title">
              Download model {downloadDone && verified && <CheckIcon size={14} color="var(--success)" />}
            </div>
            <div className="sp-step-desc">
              Llama 3.1 8B Instruct, quantized to 4-bit. About 4 GB on disk,
              verified by SHA-256 before first use.
            </div>
            <div className="sp-progress">
              <div className="sp-progress-bar" style={{ width: `${downloadPct * 100}%` }} />
            </div>
            <div className="sp-progress-meta">
              <span>{(downloaded / 1e9).toFixed(2)} GB / {(MODEL_TOTAL / 1e9).toFixed(2)} GB</span>
              <span>
                {downloadDone
                  ? verified ? "verified ✓" : "verifying SHA-256…"
                  : `${(downloadPct * 100).toFixed(0)}%`}
              </span>
            </div>
            <div className="sp-hash">{MODEL_HASH}</div>
          </div>
        </div>

        {/* Step 2: persona */}
        <div className="sp-step">
          <div className={`sp-step-num ${persona ? "done" : downloadDone && verified ? "" : "pending"}`}>2</div>
          <div className="sp-step-body">
            <div className="sp-step-title">Pick a persona</div>
            <div className="sp-step-desc">
              How should Spark talk to you? Change anytime in Settings → AI.
            </div>
            <div className="sp-personas">
              {PERSONAS.map((p) => (
                <button
                  key={p.id}
                  className={`sp-persona${persona === p.id ? " active" : ""}`}
                  disabled={!downloadDone || !verified}
                  onClick={() => setPersona(p.id)}
                >
                  <span className="sp-persona-name">{p.name}</span>
                  <span className="sp-persona-mood">{p.mood}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <button className="sp-go" disabled={!persona || !verified} onClick={finish}>
          Start with {PERSONAS.find((p) => p.id === persona)?.name ?? "…"}
        </button>
      </div>
    </Overlay>
  );
}
