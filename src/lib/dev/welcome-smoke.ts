// The welcome screen's three actions, driven without a human.
//
//   AQ_DEV_SMOKE=welcome npm run tauri:dev
//
// This exists because of what shipped in v0.1.0: "Open existing", "Create new"
// and "Try the sample" all did nothing, and no test anywhere would have
// noticed, because the two that were broken were broken in the *renderer* and
// the third asked the backend for a workflow that only the browser mock had.
//
// What it can and cannot prove:
//
//   - Creating a workflow and the sample: fully exercised, real folders on
//     real disk, through the same Rust commands the buttons call.
//   - Opening a folder by path: exercised.
//   - Opening a folder by *picker*: not exercised, and cannot be — a native
//     folder dialog needs a human or a display server. That one step is what
//     `[dialog]` lines in stderr are for.
//
// Development builds only; `main.tsx` imports it behind `import.meta.env.DEV`.

import { invoke } from "@tauri-apps/api/core";
import { vault } from "@/lib/vault";
import type { WorkflowKind, WorkflowSummary } from "@/types/vault";

const log = (line: string) => invoke("dev_log", { line }).catch(() => {});

export async function runWelcomeSmoke(): Promise<void> {
  const v = vault();
  let failures = 0;
  const check = async (label: string, ok: boolean, detail = "") => {
    if (!ok) failures++;
    await log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  };

  try {
    await log("── welcome-screen smoke pass ──");

    // ── "Try the sample" ──
    const sample = await v.createSampleWorkflow();
    await check("createSampleWorkflow returns a summary", !!sample.id, `${sample.name} at ${sample.path}`);
    const loadedSample = await v.loadWorkflow(sample.id);
    await check(
      "the sample opens and has its four chapters",
      loadedSample.workflow.manuscripts[0]?.chapterOrder.length === 4,
      JSON.stringify(loadedSample.workflow.manuscripts[0]?.chapterOrder ?? []),
    );
    const ch1 = await v.readFile(sample.id, "Drafts/Ch_01.md");
    await check("the sample's chapter one has real text", ch1.includes("[[Imogen]]"), `${ch1.length} chars`);

    // Pressing it twice must reopen, not fail and not duplicate.
    const again = await v.createSampleWorkflow();
    await check("pressing it twice reopens the same folder", again.path === sample.path, again.path);

    // ── "Create new", one per shape, into a scratch folder ──
    const parent = await invoke<string>("dev_scratch_dir");
    await log(`scratch folder: ${parent}`);
    const kinds: WorkflowKind[] = ["novel", "screenplay", "worldbuilding", "notes"];
    for (const kind of kinds) {
      const name = `Smoke ${kind}`;
      const made = await invoke<WorkflowSummary | null>("vault_create_workflow", { name, kind, parent });
      if (!made) {
        await check(`create ${kind}`, false, "returned null");
        continue;
      }
      const { workflow, tree } = await v.loadWorkflow(made.id);
      const top = (tree.children ?? []).map((c) => c.path).join(", ");
      await check(
        `create ${kind} — kind survives the round trip`,
        workflow.kind === kind,
        `title "${workflow.title}", on disk: ${top}`,
      );
    }

    // The name guard, which is what stops a typed name escaping the folder.
    for (const bad of ["", "../elsewhere", "Drafts/Ch_01"]) {
      let refused = false;
      try {
        await invoke("vault_create_workflow", { name: bad, kind: "notes", parent });
      } catch {
        refused = true;
      }
      await check(`refuses the name ${JSON.stringify(bad)}`, refused);
    }

    // ── "Open a folder by path" — the picker's escape hatch ──
    const byPath = await v.addWorkflowByPath(`${parent}/Smoke novel`);
    await check("addWorkflowByPath registers an existing folder", !!byPath.id, byPath.path);
    let refusedMissing = false;
    try {
      await v.addWorkflowByPath(`${parent}/does-not-exist`);
    } catch {
      refusedMissing = true;
    }
    await check("addWorkflowByPath refuses a folder that isn't there", refusedMissing);

    // ── the index the welcome screen actually renders ──
    // Five new entries at minimum: the sample plus one per kind. Registering
    // "Smoke novel" a second time by path is the same folder and so the same
    // id, which is the registry behaving correctly, not a sixth workflow.
    const list = await v.listWorkflows();
    await check("listWorkflows sees everything just made", list.length >= 5, `${list.length} workflows`);

    await log(`── welcome smoke ${failures === 0 ? "PASSED" : `FAILED (${failures})`} ──`);
  } catch (e) {
    // Rust command errors arrive as plain strings, not Error objects.
    await log(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
  }
}
