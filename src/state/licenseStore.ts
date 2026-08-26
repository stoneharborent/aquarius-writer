import { create } from "zustand";

// HANDOFF §9.2 — three tiers.
//   Notes  · free
//   Studio · $50 one-time (manuscript / corkboard / fountain / chapter rail / EPUB·Word·FDX·PDF)
//   Spark  · $5/mo add-on (built-in local AI; works on any tier)
//
// Tiers stack: Spark is a flag separate from the base tier (Notes or Studio).

export type BaseTier = "notes" | "studio";

export type StudioFeature =
  | "manuscript"
  | "corkboard"
  | "fountain"
  | "chapter-rail"
  | "export-epub"
  | "export-fdx"
  | "export-word"
  | "export-pdf";

export const STUDIO_FEATURE_LABEL: Record<StudioFeature, string> = {
  "manuscript": "Manuscript outline",
  "corkboard": "Corkboard",
  "fountain": "Screenplay editor",
  "chapter-rail": "Chapter rail",
  "export-epub": "EPUB export",
  "export-fdx": "Final Draft (FDX) export",
  "export-word": "Word export",
  "export-pdf": "PDF export",
};

interface LicenseState {
  base: BaseTier;
  spark: boolean;
  /** First-launch Spark setup completed (model downloaded + persona picked) */
  sparkReady: boolean;
  /** Pricing gate (Studio-only feature attempted while on Notes) */
  pendingGate: StudioFeature | null;

  upgradeToStudio: () => void;
  downgradeToNotes: () => void;
  enableSpark: () => void;
  disableSpark: () => void;
  markSparkReady: () => void;
  requestStudioFeature: (f: StudioFeature) => boolean;
  closeGate: () => void;
}

const KEY = "aquarius.license";

interface Persisted {
  base: BaseTier;
  spark: boolean;
  sparkReady: boolean;
}

function load(): Persisted {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* swallow */ }
  return { base: "notes", spark: false, sparkReady: false };
}

function persist(s: Persisted) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* swallow */ }
}

const initial = load();

export const useLicense = create<LicenseState>((set, get) => ({
  ...initial,
  pendingGate: null,

  upgradeToStudio() {
    set({ base: "studio" });
    persist({ base: "studio", spark: get().spark, sparkReady: get().sparkReady });
  },
  downgradeToNotes() {
    set({ base: "notes" });
    persist({ base: "notes", spark: get().spark, sparkReady: get().sparkReady });
  },
  enableSpark() {
    set({ spark: true });
    persist({ base: get().base, spark: true, sparkReady: get().sparkReady });
  },
  disableSpark() {
    set({ spark: false });
    persist({ base: get().base, spark: false, sparkReady: get().sparkReady });
  },
  markSparkReady() {
    set({ sparkReady: true });
    persist({ base: get().base, spark: get().spark, sparkReady: true });
  },
  requestStudioFeature(f) {
    if (get().base === "studio") return true;
    set({ pendingGate: f });
    return false;
  },
  closeGate() { set({ pendingGate: null }); },
}));

export function isStudio(s: { base: BaseTier }) { return s.base === "studio"; }
