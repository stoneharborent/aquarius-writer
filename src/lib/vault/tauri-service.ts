import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { VaultService } from "./service";
import type { VaultNode, Workflow, WorkflowSummary } from "@/types/vault";

// The real backend: every call lands in a Rust command in `src-tauri/src/`.
// Nothing here does filesystem work itself — path safety, atomic writes and
// the trash all live on the other side of `invoke`, where they can be tested
// without a browser.

/** Payload of the `vault://changed` event the watcher emits. */
interface ChangeEvent {
  workflowId: string;
}

/** What `vault_asset_ref` answers with — see the Rust doc comment. */
type AssetRef =
  | { mode: "file"; path: string }
  | { mode: "data"; url: string };

const CHANGE_EVENT = "vault://changed";

export function createTauriVaultService(): VaultService {
  return {
    async listWorkflows(): Promise<WorkflowSummary[]> {
      return invoke<WorkflowSummary[]>("vault_list_workflows");
    },

    async loadWorkflow(id): Promise<{ workflow: Workflow; tree: VaultNode }> {
      return invoke<{ workflow: Workflow; tree: VaultNode }>("vault_load_workflow", { id });
    },

    async addWorkflowFromFolder(): Promise<WorkflowSummary | null> {
      // Returns null when the writer dismissed the native folder picker.
      return invoke<WorkflowSummary | null>("vault_add_workflow_from_folder");
    },

    async readFile(workflowId, relPath) {
      return invoke<string>("vault_read_file", { workflowId, relPath });
    },

    async resolveAssetUrl(workflowId, relPath) {
      const ref = await invoke<AssetRef>("vault_asset_ref", { workflowId, relPath });
      // `file` is the normal answer: the asset protocol streams the bytes, so
      // a large PDF or a video never has to fit in a string.
      return ref.mode === "file" ? convertFileSrc(ref.path) : ref.url;
    },

    async readBinary(workflowId, relPath) {
      // The command answers with raw bytes (ArrayBuffer), not a JSON array —
      // pdf.js gets its buffer without a 3× size tax on the way through.
      const buf = await invoke<ArrayBuffer>("vault_read_binary", { workflowId, relPath });
      return new Uint8Array(buf);
    },

    async writeFile(workflowId, relPath, content) {
      await invoke("vault_write_file", { workflowId, relPath, content });
    },

    async softDelete(workflowId, relPath) {
      await invoke("vault_soft_delete", { workflowId, relPath });
    },

    watch(workflowId, onChange) {
      // `watch` is synchronous by contract but everything underneath is async,
      // so we start the subscription in the background and let the returned
      // disposer cancel it — including when it's called before setup finishes.
      let disposed = false;
      let unlisten: (() => void) | null = null;

      void (async () => {
        try {
          await invoke("vault_watch_start", { workflowId });
          const stop = await listen<ChangeEvent>(CHANGE_EVENT, (event) => {
            if (event.payload?.workflowId === workflowId) onChange();
          });
          if (disposed) stop();
          else unlisten = stop;
        } catch (e) {
          console.error("vault watch failed to start:", e);
        }
      })();

      return () => {
        disposed = true;
        unlisten?.();
        unlisten = null;
        void invoke("vault_watch_stop", { workflowId }).catch(() => {
          /* the window is going away — nothing useful left to do */
        });
      };
    },
  };
}
