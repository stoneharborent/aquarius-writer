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
 *
 * It WRITES INTO the vault it is pointed at, so it refuses to start unless
 * that vault was made for it — see `assertBenchTarget` and docs/NOTES.md §28g,
 * which is the run that put sixty generated notes in a real manuscript vault.
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
  //
  // These used to branch: `writeFile` for a note that was already in the tree,
  // `useVault.getState().createFile(…)` for one that was not. `createFile`
  // takes no workflow id — it writes into whichever workflow the STORE has
  // open — so on the one boot where the store had won a different vault, all
  // sixty landed there instead (docs/NOTES.md §28g). There is no branch now:
  // one path, one id, the same id the chapter and the screenplay use.
  // `write_atomic` creates `Characters/` if it is missing, so nothing is lost
  // by not going through `createFile`.
  for (let i = 0; i < NOTE_COUNT; i++) {
    const name = noteName(i);
    let body = `---\ntitle: ${name}\n---\n\n`;
    for (let p = 0; p < 12; p++) {
      body += `${paragraph(i * 31 + p, 40)} See [[${noteName((i + p + 1) % NOTE_COUNT)}]].\n\n`;
    }
    await v.writeFile(workflowId, `Characters/${name}.md`, body, null);
  }
}

// ── the guard ─────────────────────────────────────────────────────────────
//
// §28g: this bench once seeded sixty notes into Royce's real manuscript vault
// and then benchmarked *that*. Nothing was corrupted, but it took real
// cleanup, and the reason it happened is worth stating plainly: the bench was
// handed a scratch workflow id, and the app — which boots into the most
// recently registered workflow — had already opened a different one. Nothing
// checked that those were the same thing.
//
// So now something does. The bench does not write until it can name the
// vault it is about to write into and say why that vault is a bench vault.
// Three answers count, and nothing else does:
//
//   1. `dev_context` reported this id — i.e. `AQ_DEV_VAULT` registered it on
//      launch, which is the documented way to point the bench at a folder.
//   2. Its title or its path says "bench" — the human named it for this.
//   3. It is the browser mock's in-memory sample, which has no disk at all.
//
// And in every case the STORE must have that same workflow open, because the
// store is what the editor, the autosave and the tree all follow. An id that
// is right on paper and wrong in the store is exactly the §28g failure.

/** The browser preview's in-memory sample. Writes to it never reach a disk. */
const BROWSER_SAMPLE = "lantern";

/** What a folder made for the bench looks like: `~/aq-bench-vault`, "Bench". */
const BENCH_MARKER = /bench/i;

/** The workflow `AQ_DEV_VAULT` registered, or null outside the dev shell. */
async function devWorkflowId(): Promise<string | null> {
  if (typeof window === "undefined" || !window.__TAURI_INTERNALS__) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const ctx = await invoke<{ workflowId: string | null }>("dev_context");
    return ctx.workflowId ?? null;
  } catch {
    return null; // older shell without the command — treat it as "no answer"
  }
}

/**
 * Throw unless `workflowId` is a vault the bench is allowed to write into and
 * the store has it open. Called after `openWorkflow`, before the first write.
 */
async function assertBenchTarget(workflowId: string, devId: string | null): Promise<void> {
  const refusal = (why: string) =>
    new Error(
      `REFUSING TO RUN — ${why}. The typing bench writes 62 files into the `
      + `workflow it is given and will not do that to a vault that was not `
      + `made for it. Point it at a scratch folder with an isolated registry `
      + `(docs/NOTES.md §28g):\n`
      + `    export XDG_CONFIG_HOME="$HOME/aq-dev-config"\n`
      + `    export XDG_DATA_HOME="$HOME/aq-dev-data"\n`
      + `    export AQ_DEV_VAULT="$HOME/aq-bench-vault"\n`
      + `    VITE_AQ_BENCH=1 npm run tauri:dev`,
    );

  const current = useVault.getState().current;
  if (!current) throw refusal(`workflow "${workflowId}" did not open`);
  // The §28g check, and the one that actually failed: right id, wrong store.
  if (current.id !== workflowId) {
    throw refusal(
      `asked for workflow "${workflowId}" but the app has "${current.id}" `
      + `("${current.title}") open — every ambient write would go there`,
    );
  }

  if (devId !== null) {
    if (workflowId === devId) return;                       // AQ_DEV_VAULT's own
    throw refusal(
      `AQ_DEV_VAULT registered "${devId}" but the bench is aimed at `
      + `"${workflowId}" ("${current.title}")`,
    );
  }

  // No dev shell answered. A named-for-the-bench folder, or the mock, or no.
  if (workflowId === BROWSER_SAMPLE) return;
  if (BENCH_MARKER.test(current.title)) return;
  let path = "";
  try {
    path = (await vault().listWorkflows()).find((w) => w.id === workflowId)?.path ?? "";
  } catch { /* can't ask — fall through to the refusal */ }
  if (path && BENCH_MARKER.test(path)) return;
  throw refusal(
    `"${current.title}"${path ? ` (${path})` : ""} is not a bench vault — `
    + `AQ_DEV_VAULT did not register it and nothing about it says "bench"`,
  );
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
    // The id is settled before anything opens: what the caller passed, else
    // what the dev shell registered, else the browser mock.
    const devId = await devWorkflowId();
    const id = workflowId ?? devId ?? BROWSER_SAMPLE;
    await useVault.getState().openWorkflow(id, { quiet: true });
    await until(() => useVault.getState().current?.id === id || null, 5000);
    // Nothing above this line has written a byte. Nothing below it runs unless
    // this passes.
    await assertBenchTarget(id, devId);
    await log(`target: workflow "${useVault.getState().current?.title}" (${id})`);

    await log("seeding corpus…");
    await seed(id);

    // Reload against the explicit id rather than `refreshTree()`, which reads
    // the store's ambient "current" — the very thing §28g got wrong. The
    // guard already proved the two agree; this keeps them agreeing by
    // construction rather than by luck.
    const { workflow, tree } = await vault().loadWorkflow(id);
    useVault.setState({ current: workflow, tree });
    await sleep(500);
    const paths: string[] = [];
    const walkTree = (n: { path: string; kind: string; children?: unknown[] } | null | undefined) => {
      if (!n) return;
      if (n.kind === "markdown" || n.kind === "fountain") paths.push(n.path);
      (n.children as Array<{ path: string; kind: string; children?: unknown[] }> | undefined)
        ?.forEach(walkTree);
    };
    walkTree(tree as never);
    // ~62 in a scratch vault. A big number means a big vault, which is a vault
    // somebody writes in — see §28g. The guard should have caught it already.
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
