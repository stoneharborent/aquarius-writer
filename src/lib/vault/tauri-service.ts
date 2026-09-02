import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { VaultService } from "./service";
import type {
  ActiveDraftReport,
  EntryReport,
  FolderRoleReport,
  FileRead,
  Goals,
  ReorderReport,
  SearchHit,
  VaultNode,
  Workflow,
  WorkflowSummary,
  WriteResult,
} from "@/types/vault";

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

    async addWorkflowByPath(path): Promise<WorkflowSummary> {
      return invoke<WorkflowSummary>("vault_add_workflow_by_path", { path });
    },

    async createWorkflow(name, kind): Promise<WorkflowSummary | null> {
      // `parent: null` means "put the folder picker on screen first".
      return invoke<WorkflowSummary | null>("vault_create_workflow", {
        name,
        kind,
        parent: null,
      });
    },

    async createSampleWorkflow(): Promise<WorkflowSummary> {
      return invoke<WorkflowSummary>("vault_create_sample_workflow");
    },

    async readFile(workflowId, relPath) {
      return (await invoke<FileRead>("vault_read_file", { workflowId, relPath })).content;
    },

    async readFileStamped(workflowId, relPath) {
      return invoke<FileRead>("vault_read_file", { workflowId, relPath });
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

    async writeFile(workflowId, relPath, content, expected) {
      // `expected: null` is "no baseline, write regardless" — the shape Rust's
      // `Option<FileStamp>` wants, and what every caller but the editor's save
      // path sends.
      return invoke<WriteResult>("vault_write_file", {
        workflowId,
        relPath,
        content,
        expected: expected ?? null,
      });
    },

    async createFile(workflowId, parent, name, kind) {
      return invoke<EntryReport>("vault_create_file", { workflowId, parent, name, kind });
    },

    async createFolder(workflowId, parent, name) {
      return invoke<EntryReport>("vault_create_folder", { workflowId, parent, name });
    },

    async rename(workflowId, relPath, newName) {
      return invoke<EntryReport>("vault_rename", { workflowId, relPath, newName });
    },

    async move(workflowId, relPath, destFolder) {
      return invoke<EntryReport>("vault_move", { workflowId, relPath, destFolder });
    },

    async softDelete(workflowId, relPath) {
      await invoke("vault_soft_delete", { workflowId, relPath });
    },

    async reorderChapters(workflowId, order, manuscriptId) {
      // The same `vault::ops::reorder_chapters` the MCP tool calls — one
      // function, two doors (docs/PARITY.md row 10).
      return invoke<ReorderReport>("vault_reorder_chapters", {
        workflowId,
        order,
        manuscriptId: manuscriptId ?? null,
      });
    },

    async setDailyGoal(workflowId, dailyWords) {
      return invoke<Goals>("vault_set_daily_goal", { workflowId, dailyWords });
    },

    // The four manuscript-management calls. Each one is a thin wrapper over the
    // same `vault::ops` function its MCP tool calls — one implementation, two
    // doors (docs/PARITY.md, "One rule worth keeping").
    async toggleManuscriptFolder(workflowId, relPath) {
      return invoke<FolderRoleReport>("vault_toggle_manuscript_folder", { workflowId, relPath });
    },

    async toggleDraftFolder(workflowId, relPath) {
      return invoke<FolderRoleReport>("vault_toggle_draft_folder", { workflowId, relPath });
    },

    async setActiveDraft(workflowId, draftId) {
      return invoke<ActiveDraftReport>("vault_set_active_draft", { workflowId, draftId });
    },

    async setSynopsis(workflowId, relPath, synopsis) {
      await invoke("vault_set_synopsis", { workflowId, relPath, synopsis });
    },

    async searchWorkflow(workflowId, query) {
      return invoke<SearchHit[]>("vault_search", { workflowId, query });
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
