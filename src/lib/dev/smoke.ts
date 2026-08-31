// A scripted pass over the whole vault backend, for verifying the shell
// without a human driving the UI.
//
//   AQ_DEV_VAULT="/path/to/vault" AQ_DEV_SMOKE=1 npm run tauri:dev
//
// It walks every VaultService method against the folder `AQ_DEV_VAULT` opened,
// and reports through `dev_log` — a Rust command that prints to the terminal
// running `tauri dev`, because the WebView's console isn't visible from a
// shell. Development builds only; `main.tsx` imports it behind
// `import.meta.env.DEV`, so it is never in a production bundle.
//
// It writes to the vault it is pointed at (that is the point), so point it at
// a scratch folder, never at real work.

import { invoke } from "@tauri-apps/api/core";
import { vault } from "@/lib/vault";
import {
  listTrash,
  listVersions,
  hydrateAux,
  recordAutoVersion,
  restoreTrash,
  trashFile,
} from "@/lib/vault/aux";
import type { VaultNode } from "@/types/vault";

const log = (line: string) => invoke("dev_log", { line }).catch(() => {});

interface DevStat { len: number; modifiedMs: number }
const stat = (workflowId: string, relPath: string) =>
  invoke<DevStat>("dev_stat", { workflowId, relPath });

function flatten(node: VaultNode, out: string[] = []): string[] {
  for (const child of node.children ?? []) {
    out.push(`${child.kind === "folder" ? "dir " : "file"} ${child.path}`);
    flatten(child, out);
  }
  return out;
}

export async function runDevSmoke(workflowId: string): Promise<void> {
  const v = vault();
  try {
    await log("── vault backend smoke pass ──");

    const workflows = await v.listWorkflows();
    await log(`listWorkflows → ${workflows.length}: ${workflows
      .map((w) => `${w.name} [${w.kind}, ${w.items} items, ${w.updated}]`)
      .join(" | ")}`);

    const { workflow, tree } = await v.loadWorkflow(workflowId);
    await log(`loadWorkflow → "${workflow.title}" (${workflow.kind}), id ${workflow.id}`);
    await log(`  manuscripts: ${JSON.stringify(workflow.manuscripts.map((m) => m.folder))}, chapters: ${JSON.stringify(workflow.manuscripts[0]?.chapterOrder ?? [])}`);
    for (const line of flatten(tree)) await log(`  ${line}`);

    // A file WITH frontmatter: the tree should have parsed it.
    const ch1 = tree.children
      ?.find((c) => c.path === "Drafts")
      ?.children?.find((c) => c.path === "Drafts/Ch_01.md");
    await log(`  Ch_01 frontmatter → ${JSON.stringify(ch1?.frontmatter ?? null)}, words ${ch1?.words}`);

    // ── read / write, on the file that has NO frontmatter ──
    const plain = "Characters/Old Sennet.md";
    const before = await v.readFile(workflowId, plain);
    await log(`readFile("${plain}") → ${before.length} chars, starts "${before.slice(0, 32)}"`);

    // The contract's hardest rule: saving a file whose bytes didn't change
    // must not rewrite it — so a file with no frontmatter can never gain one.
    const statBefore = await stat(workflowId, plain);
    await new Promise((r) => setTimeout(r, 1100)); // outlive mtime granularity
    await v.writeFile(workflowId, plain, before);
    const statAfterNoop = await stat(workflowId, plain);
    await log(
      `writeFile(unchanged) → len ${statBefore.len}→${statAfterNoop.len}, ` +
      `mtime ${statBefore.modifiedMs}→${statAfterNoop.modifiedMs} ` +
      `(untouched=${statBefore.modifiedMs === statAfterNoop.modifiedMs})`,
    );

    const changed = `${before.trimEnd()}\nHe counts the wakes.\n`;
    await v.writeFile(workflowId, plain, changed);
    const after = await v.readFile(workflowId, plain);
    const statAfterWrite = await stat(workflowId, plain);
    await log(
      `writeFile(changed) → re-read ${after.length} chars, match=${after === changed}, ` +
      `mtime moved=${statAfterWrite.modifiedMs !== statAfterNoop.modifiedMs}, ` +
      `has frontmatter=${after.startsWith("---")}`,
    );

    // ── the conflict guard, end to end through the real backend ──
    // A save that carries the baseline it read must win; the same save made
    // after something else touched the file must be refused with that
    // something else's text, and must not have written anything.
    const stamped = await v.readFileStamped(workflowId, plain);
    const guarded = await v.writeFile(
      workflowId, plain, `${stamped.content}\nGuarded.\n`, stamped.stamp,
    );
    await log(
      `writeFile(matching baseline) → ${guarded.status}` +
      `${guarded.status === "written" ? `, changed=${guarded.changed}` : ""}`,
    );

    // Something else edits the file; our stamp is now stale.
    const stale = await v.readFileStamped(workflowId, plain);
    await v.writeFile(workflowId, plain, `${stale.content}\nSomebody else.\n`, null);
    const refused = await v.writeFile(workflowId, plain, "my unsaved paragraph", stale.stamp);
    const onDisk = await v.readFile(workflowId, plain);
    await log(
      `writeFile(stale baseline) → ${refused.status} ` +
      `(theirs ends "${refused.status === "conflict" ? refused.theirs.trimEnd().slice(-14) : "—"}"), ` +
      `disk untouched=${onDisk !== "my unsaved paragraph"}`,
    );

    // ── binary + asset ──
    const bytes = await v.readBinary(workflowId, "Research/Notes.pdf");
    await log(`readBinary("Research/Notes.pdf") → ${bytes.byteLength} bytes, magic "${new TextDecoder().decode(bytes.slice(0, 5))}"`);
    const url = await v.resolveAssetUrl(workflowId, "Research/Notes.pdf");
    await log(`resolveAssetUrl → ${url.slice(0, 72)}${url.length > 72 ? "…" : ""}`);

    // ── versions on disk (was localStorage) ──
    await hydrateAux(workflowId);
    recordAutoVersion(workflowId, plain, changed);
    await new Promise((r) => setTimeout(r, 150));
    await log(`listVersions("${plain}") → ${listVersions(workflowId, plain).length} entry/entries`);

    // ── soft delete, then restore ──
    const doomed = "Drafts/Ch_02.md";
    try {
      await trashFile(workflowId, doomed);
      await log(`softDelete("${doomed}") → trash holds ${JSON.stringify(listTrash(workflowId).map((t) => t.path))}`);
    } catch (e) {
      await log(`softDelete skipped (${String(e)}); trash holds ${JSON.stringify(listTrash(workflowId).map((t) => t.path))}`);
    }
    const entry = listTrash(workflowId).find((t) => t.path === doomed);
    if (entry) {
      const restoredPath = await restoreTrash(workflowId, entry.id);
      const revived = await v.readFile(workflowId, doomed);
      await log(`restoreTrash → "${restoredPath}" back on disk, ${revived.length} chars; trash now ${listTrash(workflowId).length} entries`);
    }

    // ── the watcher, proven from the renderer's side ──
    // The store already re-syncs the tree on change; this second subscription
    // exists purely so an external edit leaves a line in the terminal.
    v.watch(workflowId, () => {
      void (async () => {
        const { tree: fresh } = await vault().loadWorkflow(workflowId);
        void log(`watch → change received; tree now has ${flatten(fresh).length} entries`);
      })();
    });

    await log("── smoke pass complete; watching for external edits ──");
  } catch (e) {
    // Rust command errors arrive as plain strings, not Error objects.
    await log(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
  }
}
