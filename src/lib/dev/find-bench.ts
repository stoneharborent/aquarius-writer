/**
 * The Find bench — `VITE_AQ_FIND_BENCH=1` (docs/NOTES.md §33).
 *
 * WHY IT EXISTS. Royce's report on the semantic-search build was "the search
 * and find gets stuck when trying to search or type and takes a long time to
 * register". §27l's bench answers "how long between a key going down and the
 * character appearing"; this answers the other question the Find sheet raises —
 * **how long between the last keystroke of a query and the results being
 * there**, and how many `readFile` round trips it took to get them.
 *
 * WHAT IT MEASURES, in the shell, against whatever vault `AQ_DEV_VAULT`
 * registered:
 *
 * 1. **Tree size** — nodes and folders in the tree the backend handed over.
 *    That is the number every tree-walking feature pays for, and the one a
 *    dependency folder inflates.
 * 2. **Find latency** — `searchWorkflow` for a two-letter query, the shortest
 *    the sheet will act on, run three times and reported as the median.
 * 3. **readFile round trips per query** — counted by wrapping the service.
 *    After the search moved into Rust this must be **zero**; before it, it was
 *    one per text file in the tree, sequentially awaited.
 *
 * It only ever READS. Unlike `typing-bench.ts` it seeds nothing, so it needs no
 * `assertBenchTarget` — but run it the way §28g requires anyway, with an
 * isolated `XDG_CONFIG_HOME`, so it measures the vault you think it does:
 *
 *     export XDG_CONFIG_HOME="$HOME/aq-ignore-config"
 *     export XDG_DATA_HOME="$HOME/aq-ignore-data"
 *     export AQ_DEV_VAULT="$HOME/aq-ignore-vault"
 *     VITE_AQ_FIND_BENCH=1 npm run tauri:dev
 *
 * Development builds only — `main.tsx` reaches it through a dynamic import
 * inside an `import.meta.env.DEV` guard.
 */

import { vault } from "@/lib/vault";
import { searchWorkflow } from "@/lib/vault/aux";
import { useVault } from "@/state/vaultStore";
import type { VaultNode } from "@/types/vault";

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

function census(node: VaultNode): { nodes: number; folders: number; files: number } {
  let nodes = 1;
  let folders = node.kind === "folder" ? 1 : 0;
  let files = node.kind === "folder" ? 0 : 1;
  for (const child of node.children ?? []) {
    const sub = census(child);
    nodes += sub.nodes;
    folders += sub.folders;
    files += sub.files;
  }
  return { nodes, folders, files };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** How long the watcher phase waits for someone to touch a file. */
const WATCH_SECONDS = 25;

/**
 * Resolve when the store's tree object is replaced — which only happens when
 * the workflow reloads, which only happens when the watcher decided an event
 * was interesting.
 */
function waitForTreeChange(ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const before = useVault.getState().tree;
    const stop = useVault.subscribe((s) => {
      if (s.tree && s.tree !== before) { clearTimeout(timer); stop(); resolve(true); }
    });
    const timer = setTimeout(() => { stop(); resolve(false); }, ms);
  });
}

export async function runFindBench(workflowId?: string): Promise<void> {
  const query = "la";
  await log("── find bench ─────────────────────────────────────────────");

  // Give the app a moment to finish opening whatever vault it opened.
  for (let i = 0; i < 200 && !useVault.getState().tree; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const state = useVault.getState();
  const wf = state.current;
  const tree = state.tree;
  if (!wf || !tree) {
    await log("no workflow open — nothing to measure");
    return;
  }
  if (workflowId && wf.id !== workflowId) {
    await log(`WARNING: dev_context said ${workflowId} but the store has ${wf.id}`);
  }
  const { nodes, folders, files } = census(tree);
  await log(`vault: ${wf.title} (${wf.id})`);
  await log(`tree:  ${nodes} nodes — ${folders} folders, ${files} files`);

  // Count the IPC reads the search makes, by wrapping the live service.
  const svc = vault() as unknown as Record<string, unknown>;
  const realRead = svc.readFile as (w: string, p: string) => Promise<string>;
  let reads = 0;
  svc.readFile = (w: string, p: string) => { reads += 1; return realRead.call(svc, w, p); };

  const samples: number[] = [];
  let hits = 0;
  try {
    for (let run = 0; run < 3; run++) {
      reads = 0;
      const t0 = performance.now();
      const found = await searchWorkflow(wf.id, tree, query);
      samples.push(performance.now() - t0);
      hits = found.length;
    }
  } finally {
    svc.readFile = realRead;
  }

  await log(`query "${query}": ${hits} files hit`);
  await log(`latency: ${samples.map((s) => `${Math.round(s)}ms`).join(" / ")}  →  median ${Math.round(median(samples))}ms`);
  await log(`readFile round trips for the last query: ×${reads}`);

  // The other half of the ignore rule: the watcher's filter got narrower, so
  // prove it did not go too far. Touch a real note from another process while
  // this waits and the tree should come back changed; touch something under a
  // dependency folder and it should not.
  await log(`watching for an external edit for ${WATCH_SECONDS}s…`);
  const changed = await waitForTreeChange(WATCH_SECONDS * 1000);
  if (changed) {
    const after = census(useVault.getState().tree!);
    await log(`external edit seen — tree now ${after.nodes} nodes, ${after.files} files`);
  } else {
    await log("no external edit arrived in the window");
  }
  await log("───────────────────────────────────────────────────────────");
}
