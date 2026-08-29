import type { VaultService } from "./service";
import type {
  VaultNode,
  Workflow,
  WorkflowKind,
  WorkflowSummary,
} from "@/types/vault";

// Sample data — drawn from HANDOFF.md §3 sketch. Lets the browser preview
// exercise the full UI without a real filesystem. The Tauri service replaces
// this in the shipping shell.

const LANTERN_WORKFLOW: Workflow = {
  id: "lantern",
  title: "Lantern, Lantern",
  kind: "novel",
  drafts: [
    {
      id: "draft-working",
      name: "Working Draft",
      active: true,
      chapterOrder: [
        "Drafts/Ch_01.md",
        "Drafts/Ch_02.md",
        "Drafts/Ch_03.md",
        "Drafts/Ch_04.md",
      ],
    },
  ],
  manuscripts: [
    {
      id: "ms-1",
      title: "Lantern, Lantern",
      folder: "Drafts",
      chapterOrder: [
        "Drafts/Ch_01.md",
        "Drafts/Ch_02.md",
        "Drafts/Ch_03.md",
        "Drafts/Ch_04.md",
      ],
    },
  ],
  settings: { theme: "parchment", accent: "blue", fontSize: 17 },
  goals: { dailyWords: 1000, kind: "daily" },
};

function mkChapter(
  n: number,
  title: string,
  status: "final" | "drafting" | "rev" | "outline",
  words: number,
  synopsis: string,
): VaultNode {
  const num = String(n).padStart(2, "0");
  return {
    name: `Ch ${num} · ${title}`,
    path: `Drafts/Ch_${num}.md`,
    kind: "markdown",
    frontmatter: { title, status, synopsis },
    words,
  };
}

const LANTERN_TREE: VaultNode = {
  name: "Lantern, Lantern",
  path: "",
  kind: "folder",
  children: [
    {
      name: "Drafts",
      path: "Drafts",
      kind: "folder",
      children: [
        mkChapter(1, "A Door of Letters", "final", 2410,
          "Fifty-three letters from her grandfather, found in a drawer. She does not open them. She makes coffee instead. The lantern blinks twice and rests."),
        mkChapter(2, "The Bell Ringer's Vow", "final", 3105,
          "Routines of the lighthouse: bread, log, salt. Sennet teaches her the names of the rocks. She begins to dream in his voice."),
        mkChapter(3, "Helmreach in Rain", "drafting", 1880,
          "The city wore the rain like a coat too large for it — Imogen arrives at the cathedral square wet through, with a letter folded in three."),
        mkChapter(4, "The Long Echo", "outline", 240,
          "Arrival at the cathedral; the third bell rings out of order; a name Sennet refuses to say aloud."),
      ],
    },
    {
      name: "Characters",
      path: "Characters",
      kind: "folder",
      children: [
        { name: "Old Sennet", path: "Characters/Old Sennet.md", kind: "markdown" },
        { name: "Imogen", path: "Characters/Imogen.md", kind: "markdown" },
        { name: "The Bell Ringer", path: "Characters/The Bell Ringer.md", kind: "markdown" },
      ],
    },
    {
      name: "Worldbuilding",
      path: "Worldbuilding",
      kind: "folder",
      children: [
        { name: "Helmreach", path: "Worldbuilding/Helmreach.md", kind: "markdown" },
        { name: "The Order of Lamps", path: "Worldbuilding/Order of Lamps.md", kind: "markdown" },
      ],
    },
    {
      name: "Research",
      path: "Research",
      kind: "folder",
      children: [
        { name: "Cathedral diagram.jpg", path: "Research/Cathedral diagram.jpg", kind: "image" },
        { name: "Bell-pull mechanics.pdf", path: "Research/Bell-pull mechanics.pdf", kind: "pdf" },
      ],
    },
    {
      name: "Episodes",
      path: "Episodes",
      kind: "folder",
      children: [
        {
          name: "Pilot — Cold Open.fountain",
          path: "Episodes/Pilot — Cold Open.fountain",
          kind: "fountain",
        },
      ],
    },
  ],
};

const WORKFLOWS_INDEX: WorkflowSummary[] = [
  { id: "lantern", name: "Lantern, Lantern", path: "~/Workflows/Imogen/Lantern", kind: "novel", items: 47, active: true, color: "blue", updated: "now" },
  { id: "echo", name: "The Long Echo", path: "~/Workflows/Imogen/Echo", kind: "screenplay", items: 22, color: "sepia", updated: "yesterday" },
  { id: "helmreach", name: "Helmreach Bible", path: "~/Workflows/Worldbuilding/Helmreach", kind: "worldbuilding", items: 88, color: "sage", updated: "3d ago" },
  { id: "journal", name: "Daily Journal", path: "~/Workflows/Journal", kind: "notes", items: 412, color: "purple", updated: "Apr 12" },
];

const FILE_CONTENTS: Record<string, string> = {
  "Drafts/Ch_01.md": "---\ntitle: A Door of Letters\nstatus: final\n---\n\n[[Imogen]] arrived at the lighthouse on a wet October morning. [[Old Sennet]] met her at the dock — not what she expected.",
  "Drafts/Ch_02.md": "---\ntitle: The Bell Ringer's Vow\nstatus: final\n---\n\nRoutines of [[Helmreach]]: bread, log, salt. [[Old Sennet]] teaches her the names of the rocks.",
  "Drafts/Ch_03.md": "---\ntitle: Helmreach in Rain\nstatus: drafting\n---\n\nThe city of [[Helmreach]] wore the rain like a coat too large for it. [[Imogen]] arrives at the cathedral square wet through, with a letter folded in three. The letter is from [[The Bell Ringer]].",
  "Drafts/Ch_04.md": "---\ntitle: The Long Echo\nstatus: outline\n---\n\n- arrival at the cathedral in [[Helmreach]]\n- the third bell rings out of order\n- [[The Bell Ringer]] refuses to say [[Old Sennet]]'s name",
  "Characters/Imogen.md": "---\ntitle: Imogen\n---\n\n# Imogen\n\nNiece of [[Old Sennet]]. Arrived at the lighthouse in [[Helmreach]] in October. Carries fifty-three letters from her grandfather.\n\n## Voice\n\nQuiet, observant. Will not be hurried. Tells the truth slant.\n\n## Arc\n\nLearns the names of the rocks; learns the cost of [[The Order of Lamps]].",
  "Characters/Old Sennet.md": "---\ntitle: Old Sennet\n---\n\n# Old Sennet\n\nLighthouse keeper at [[Helmreach]]. Older than the daughter remembers. Stops correcting [[Imogen]]'s pronunciation in winter — first sign something is wrong.",
  "Characters/The Bell Ringer.md": "---\ntitle: The Bell Ringer\n---\n\n# The Bell Ringer\n\nKnows [[Old Sennet]] by his first name — which no one else does. Refuses to call out a trawler in trouble. Counts the wakes.",
  "Worldbuilding/Helmreach.md": "---\ntitle: Helmreach\n---\n\n# Helmreach\n\nA port city. Twelve bells across the bay. Home to [[The Order of Lamps]]. The lighthouse where [[Old Sennet]] and [[Imogen]] live sits on the cape, three miles north.",
  "Worldbuilding/Order of Lamps.md": "---\ntitle: The Order of Lamps\n---\n\n# The Order of Lamps\n\nThe society that keeps the [[Helmreach]] lights lit. [[Old Sennet]] is the senior keeper but rarely attends. They keep score.",
  "Episodes/Pilot — Cold Open.fountain":
`Title: The Long Echo
Credit: Written by
Author: Imogen Vale
Source: Based on "Lantern, Lantern"
Draft date: May 19, 2026
Contact: imogen@stoneharbor.example

INT. LIGHTHOUSE GALLERY — NIGHT

Wind. The lamp turns. SENNET stands at the rail, watching the bay. Boots wet. He is sixty-eight years old and looks every year of it tonight.

MARIN (O.S.)
Sennet?

He doesn't turn.

SENNET
Twelve bells. You hear them?

MARIN steps into the gallery, oilskin dripping. Half his age and a head shorter. She listens.

MARIN
I count seven.

SENNET
Seven across the bay. Five from the cathedral. That's twelve.

He finally looks at her. The lamp passes between them — face, dark, face, dark.

SENNET (CONT'D)
A trawler is in trouble out there.

MARIN
Then call it in.

A long beat. The lamp turns.

SENNET
No.

CUT TO:

EXT. HEADLAND — CONTINUOUS

The lighthouse from below — small against the storm. The third bell, somewhere in the dark, rings out of order.

FADE OUT.
`,
};

// Synthetic assets for the browser preview. The "photograph" is a hand-tuned
// SVG (per HANDOFF §6 — the chrome is contract, the content is illustrative).
// The PDF is generated lazily on first request.

const SYNTHETIC_PHOTOGRAPH_SVG = `data:image/svg+xml;utf8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800">
  <defs>
    <linearGradient id="sky" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="#6e7a8e"/>
      <stop offset="1" stop-color="#bcb19b"/>
    </linearGradient>
    <linearGradient id="sea" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="#3a4a55"/>
      <stop offset="1" stop-color="#1d272f"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="500" fill="url(#sky)"/>
  <rect y="500" width="1200" height="300" fill="url(#sea)"/>
  <rect x="540" y="280" width="120" height="220" fill="#d8cfb6" stroke="#7d6f55" stroke-width="2"/>
  <polygon points="540,280 660,280 600,200" fill="#5a4a36"/>
  <rect x="588" y="320" width="24" height="40" fill="#332923"/>
  <circle cx="600" cy="226" r="10" fill="#f4e4a4"/>
  <text x="20" y="780" font-family="monospace" font-size="14" fill="rgba(255,255,255,0.6)">Helmreach Cathedral · plate II · pencil and wash</text>
</svg>`)}`;

const ASSET_URLS: Record<string, string> = {
  "Research/Cathedral diagram.jpg": SYNTHETIC_PHOTOGRAPH_SVG,
};

// Synthetic asset *factories*. We build fresh bytes every call — pdf.js's
// worker takes ownership of the ArrayBuffer (transfers it), so a cached
// instance becomes detached after the first load.
const BINARY_FACTORIES: Record<string, () => Uint8Array> = {
  "Research/Bell-pull mechanics.pdf": buildPlaceholderPdf,
};

function readBinaryAsset(relPath: string): Uint8Array | null {
  const f = BINARY_FACTORIES[relPath];
  return f ? f() : null;
}

function buildPlaceholderPdf(): Uint8Array {
  // Tiny one-page PDF with a Helvetica title. Hand-rolled to avoid pulling in
  // a PDF writer for what's effectively a fixture.
  const stream = "BT /F1 18 Tf 72 720 Td (Bell-pull mechanics — Helmreach Cathedral) Tj ET\n" +
    "BT /F1 12 Tf 72 690 Td (Notes on the third bell. Counterweight diagram opposite.) Tj ET";
  const objs: string[] = [];
  objs.push("1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj");
  objs.push("2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj");
  objs.push("3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj");
  objs.push(`4 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj`);
  objs.push("5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj");

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const o of objs) {
    offsets.push(pdf.length);
    pdf += o + "\n";
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += String(off).padStart(10, "0") + " 00000 n \n";
  pdf += `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

/** A picker row for a workflow the preview cannot actually make on disk. */
function stubSummary(name: string, path: string, kind: WorkflowKind): WorkflowSummary {
  return { id: `wf-${Date.now()}`, name, path, kind, items: 0, color: "blue", updated: "now" };
}

export function createBrowserVaultService(): VaultService {
  return {
    async listWorkflows() {
      return WORKFLOWS_INDEX;
    },
    async loadWorkflow(id) {
      if (id !== "lantern") {
        throw new Error(`Browser mock only ships the Lantern workflow (asked for ${id}).`);
      }
      return { workflow: LANTERN_WORKFLOW, tree: LANTERN_TREE };
    },
    async addWorkflowFromFolder() {
      // Browser preview can't open a real folder picker. Echo a stub.
      return stubSummary("Untitled workflow", "~/Workflows/Untitled", "notes");
    },
    async addWorkflowByPath(path) {
      return stubSummary(path.split("/").filter(Boolean).pop() ?? "Untitled", path, "notes");
    },
    async createWorkflow(name, kind) {
      return stubSummary(name, `~/Workflows/${name}`, kind);
    },
    async createSampleWorkflow() {
      // The preview *is* the sample — hand back the row that opens it.
      return WORKFLOWS_INDEX[0];
    },
    async readFile(_workflowId, relPath) {
      return FILE_CONTENTS[relPath] ?? "";
    },
    async resolveAssetUrl(_workflowId, relPath) {
      const url = ASSET_URLS[relPath];
      if (url) return url;
      throw new Error(`Asset not found: ${relPath}`);
    },
    async readBinary(_workflowId, relPath) {
      const bytes = readBinaryAsset(relPath);
      if (bytes) return bytes;
      throw new Error(`Binary not found: ${relPath}`);
    },
    async writeFile(_workflowId, relPath, content) {
      FILE_CONTENTS[relPath] = content;
    },
    async softDelete(_workflowId, _relPath) {
      // No-op in browser mock.
    },
    watch(_workflowId, _onChange) {
      return () => {};
    },
  };
}
