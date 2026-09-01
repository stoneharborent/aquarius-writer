/**
 * The typing bench — `VITE_AQ_BENCH=1` (docs/NOTES.md §27l).
 *
 * WHY IT EXISTS. §27k fixed the *paint* cost of scrolling and left "sluggish
 * and delayed when typing" standing, because nothing here measured a
 * keystroke. The frame meter (perf-meter.ts) answers "how does scrolling
 * feel"; this answers the other half — **how long between a character arriving
 * and the frame that shows it** — per pane, because the three panes do very
 * different amounts of work per keystroke.
 *
 * WHAT IT MEASURES. It seeds a document of realistic size, warms up, then
 * dispatches single-character inserts one at a time. After each it waits for
 * `requestAnimationFrame` *and then* a macrotask, so the clock stops after the
 * frame containing that character has been painted, not when the transaction
 * was queued. React's render, every store subscriber that woke, every
 * O(document) recompute and the paint all fall inside the interval.
 *
 * It also counts `readFile` calls during the burst. **A keystroke should make
 * zero.** Anything above zero is a component doing I/O on the typing path,
 * which is the most expensive mistake available here.
 *
 * REPORTED as p50 / p95 / worst, because typing lag is a tail phenomenon: a
 * mean of 8ms with a p95 of 90ms is exactly what "delayed" feels like, and the
 * mean on its own hides it.
 *
 *     VITE_AQ_BENCH=1 npm run tauri:dev          # in the real shell
 *     VITE_AQ_BENCH=1 npm run dev                # in any WebKitGTK host
 *
 * Development builds only — `main.tsx` reaches it through a dynamic import
 * inside an `import.meta.env.DEV` guard, so it is never in a shipped bundle.
 * It WRITES INTO the vault it is pointed at. Point it at a scratch folder.
 */

import { EditorSelection } from "@codemirror/state";
import { formatBus } from "@/lib/format/formatBus";
import { vault } from "@/lib/vault";
import { useVault } from "@/state/vaultStore";
import { useEditor } from "@/state/editorStore";

/** Reaches the terminal running `tauri dev`; the WebView console does not. */
async function log(line: string): Promise<void> {
  console.log(line);
  if (typeof window !== "undefined" && window.__TAURI_INTERNALS__) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("dev_log", { line });
    } catch { /* not a dev shell */ }
  }
}

/**
 * Stop the clock once the typed character is on screen — or as close to that
 * as the host allows.
 *
 * `requestAnimationFrame` is the honest probe: its callback runs immediately
 * before style/layout/paint, so one frame's wait means the previous frame's
 * work is finished. But WebKitGTK stops servicing rAF *entirely* when the
 * window is not being composited — occluded, unmapped, off-screen — and a
 * bench that hangs forever is worse than one that measures slightly less. So
 * `probeRaf` asks once, and `settle` falls back to draining the scheduler and
 * flushing style + layout by hand. The fallback misses paint and compositing
 * only; every millisecond of JS, React and layout is still inside the
 * interval, which is where the typing cost lives (§27k already took the paint
 * cost out).
 */
let rafAlive = true;

function probeRaf(): Promise<boolean> {
  return new Promise((res) => {
    let settled = false;
    requestAnimationFrame(() => { settled = true; res(true); });
    setTimeout(() => { if (!settled) res(false); }, 800);
  });
}

/** A macrotask that lands after React's MessageChannel-scheduled render. */
const macrotask = () =>
  new Promise<void>((r) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { ch.port1.close(); r(); };
    ch.port2.postMessage(0);
  });

async function settle(probe: HTMLElement): Promise<void> {
  if (rafAlive) {
    await new Promise<void>((r) => requestAnimationFrame(() => setTimeout(() => r(), 0)));
    return;
  }
  await macrotask();
  await new Promise<void>((r) => setTimeout(r, 0));
  // Force style + layout so their cost is paid inside the measured interval
  // rather than deferred to a frame nobody is waiting for.
  void probe.getBoundingClientRect().height;
  void probe.ownerDocument.documentElement.getBoundingClientRect().height;
}

/** Never let one wedged frame hang the whole run. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  return Promise.race([p, sleep(ms).then(() => "timeout" as const)]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(probe: () => T | null | undefined, ms = 20000): Promise<T | null> {
  const deadline = performance.now() + ms;
  for (;;) {
    const hit = probe();
    if (hit) return hit;
    if (performance.now() > deadline) return null;
    await sleep(50);
  }
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

// ── the corpus ────────────────────────────────────────────────────────────
// Deterministic, so two runs measure the same document.

const LEXICON = ("the lantern swung low across the black water and Sennet counted "
  + "wakes he could not name while the harbour held its breath against a tide "
  + "that had already turned somewhere far out past the shoal where light stops "
  + "mattering and the gulls go quiet before weather").split(/\s+/);

function paragraph(seed: number, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += (i ? " " : "") + LEXICON[(seed * 7 + i * 13) % LEXICON.length];
  return out[0].toUpperCase() + out.slice(1) + ".";
}

const NOTE_COUNT = 60;
const noteName = (i: number) => `Bench Note ${String(i + 1).padStart(2, "0")}`;

async function seed(workflowId: string): Promise<void> {
  const v = vault();

  // A ~5,000-word chapter — a real one, not the 30-word sample.
  let chapter = "---\ntitle: A Door of Letters\nstatus: drafting\n---\n\n";
  for (let p = 0; p < 100; p++) chapter += paragraph(p, 50) + "\n\n";
  await v.writeFile(workflowId, "Drafts/Ch_01.md", chapter, null);

  // A ~90-page screenplay.
  let script = "Title: THE SHOAL\nCredit: Written by\nAuthor: R. Adkins\n\n";
  for (let s = 0; s < 90; s++) {
    script += `INT. HARBOUR OFFICE - NIGHT\n\n${paragraph(s, 30)}\n\n`;
    script += `SENNET\n${paragraph(s + 1, 14)}\n\n`;
    script += `EXT. QUAY - CONTINUOUS\n\n${paragraph(s + 2, 26)}\n\n`;
  }
  await v.writeFile(workflowId, SCREENPLAY, script, null);

  // Sixty densely cross-linked notes — what Backlinks has to scan.
  const store = useVault.getState();
  const existing = new Set<string>();
  const walk = (n: { path: string; children?: unknown[] } | null) => {
    if (!n) return;
    existing.add(n.path);
    (n.children as Array<{ path: string; children?: unknown[] }> | undefined)
      ?.forEach((c) => walk(c));
  };
  walk(store.tree as never);

  for (let i = 0; i < NOTE_COUNT; i++) {
    const name = noteName(i);
    const path = `Characters/${name}.md`;
    let body = `---\ntitle: ${name}\n---\n\n`;
    for (let p = 0; p < 12; p++) {
      body += `${paragraph(i * 31 + p, 40)} See [[${noteName((i + p + 1) % NOTE_COUNT)}]].\n\n`;
    }
    if (existing.has(path)) {
      await v.writeFile(workflowId, path, body, null);
    } else {
      await store.createFile("Characters", name, "markdown", { content: body, open: false });
    }
  }
}

// ── the run ───────────────────────────────────────────────────────────────

const SCREENPLAY = "Episodes/Pilot — Cold Open.fountain";
const KEYSTROKES = 60;
const WARMUP = 10;

interface Scenario { label: string; path: string }

async function benchOne(sc: Scenario): Promise<void> {
  const store = useVault.getState();
  store.selectPath(sc.path);
  store.setView("editor");

  // `formatBus.target(path)` falls back to "the only registered view" when the
  // path it was asked for has none — which silently benches the PREVIOUS
  // scenario's document through a detached editor, and reports it as this one.
  // Demand a buffer, and an editor still attached to the document.
  const view = await until(() => {
    if (!useEditor.getState().docs[sc.path]) return null;
    const v = formatBus.target(sc.path);
    return v && v.dom.isConnected ? v : null;
  });
  if (!view) {
    const known = useEditor.getState().docs[sc.path] ? "buffer open, no attached editor" : "no buffer";
    await log(`  ${sc.label.padEnd(11)} SKIPPED — ${sc.path}: ${known}`);
    return;
  }
  // Let the pane settle: first layout, syntax tree, mount-time effects.
  await sleep(1500);
  const pane = (view.dom.closest("article") as HTMLElement | null)?.className ?? "?";
  await log(`  ${sc.label.padEnd(11)} doc ${view.state.doc.length} chars, pane "${pane}"`);

  // Count disk reads made while typing. A keystroke should cause none.
  const v = vault() as unknown as Record<string, unknown>;
  const originalRead = v.readFile as (...a: unknown[]) => Promise<string>;
  let reads = 0;
  v.readFile = (...a: unknown[]) => { reads++; return originalRead.apply(v, a); };

  const samples: number[] = [];
  let stalls = 0;
  try {
    for (let i = 0; i < WARMUP + KEYSTROKES; i++) {
      const at = view.state.doc.length;
      const t0 = performance.now();
      view.dispatch({
        changes: { from: at, insert: "x" },
        selection: EditorSelection.cursor(at + 1),
      });
      const outcome = await withDeadline(settle(view.contentDOM), 3000);
      const dt = performance.now() - t0;
      if (outcome === "timeout") stalls++;
      else if (i >= WARMUP) samples.push(dt);
    }
  } finally {
    v.readFile = originalRead;
  }

  if (!samples.length) {
    await log(`  ${sc.label.padEnd(11)} — no samples (${stalls} stalled frames)`);
    return;
  }

  samples.sort((a, b) => a - b);
  const mean = samples.reduce((s, n) => s + n, 0) / samples.length;
  await log(
    `  ${sc.label.padEnd(11)}` +
    ` p50 ${quantile(samples, 0.5).toFixed(1).padStart(7)}ms` +
    `  p95 ${quantile(samples, 0.95).toFixed(1).padStart(7)}ms` +
    `  worst ${samples[samples.length - 1].toFixed(1).padStart(7)}ms` +
    `  mean ${mean.toFixed(1).padStart(7)}ms` +
    `  readFile x${reads}` +
    (stalls ? `  STALLED x${stalls}` : ""),
  );
}

export async function runTypingBench(workflowId?: string): Promise<void> {
  await log("BENCH-BEGIN");
  try {
    // rAF looks alive at start and then stops being serviced the moment the
    // window is occluded or loses the compositor, which wedges an unattended
    // run at the watchdog. The layout probe is deterministic and measures the
    // half this pass is about — JS, React and layout — so it is the default.
    // Set VITE_AQ_BENCH_RAF=1 to trust the compositor instead.
    rafAlive = import.meta.env.VITE_AQ_BENCH_RAF === "1" ? await probeRaf() : false;
    await log(rafAlive
      ? "probe: requestAnimationFrame — keystroke to painted frame"
      : "probe: forced layout — keystroke to laid-out frame (paint excluded; "
        + "27k already took the paint cost out)");
    const id = workflowId ?? "lantern";
    await useVault.getState().openWorkflow(id, { quiet: true });
    const tree = await until(() => useVault.getState().tree);
    if (!tree) { await log("no tree loaded — nothing to bench"); await log("BENCH-END"); return; }

    await log("seeding corpus…");
    await seed(id);
    await useVault.getState().refreshTree();
    await sleep(500);
    const paths: string[] = [];
    const walkTree = (n: { path: string; kind: string; children?: unknown[] } | null | undefined) => {
      if (!n) return;
      if (n.kind === "markdown" || n.kind === "fountain") paths.push(n.path);
      (n.children as Array<{ path: string; kind: string; children?: unknown[] }> | undefined)
        ?.forEach(walkTree);
    };
    walkTree(useVault.getState().tree as never);
    await log(`seeded: ${paths.length} editable files in the tree`);

    await log("── typing bench: keystroke → painted frame ──");
    for (const sc of [
      { label: "prose", path: "Drafts/Ch_01.md" },
      { label: "note", path: `Characters/${noteName(0)}.md` },
      { label: "screenplay", path: SCREENPLAY },
    ] as Scenario[]) {
      try {
        await benchOne(sc);
      } catch (e) {
        await log(`  ${sc.label} failed: ${String(e)}`);
      }
      // Drain the autosave debounce so its write is not charged to the next
      // pane's first keystrokes.
      try { await useEditor.getState().flushSave(sc.path); } catch { /* ignore */ }
      await sleep(400);
    }
  } catch (e) {
    await log(`bench aborted: ${String(e)}`);
  }
  await log("BENCH-END");
}
