import type { VaultNode, Workflow, WorkflowKind, WorkflowSummary } from "@/types/vault";

/** Vault service contract — implemented twice: browser-mock and tauri-fs. */
export interface VaultService {
  /** Workflows the user has connected (recent + active). */
  listWorkflows(): Promise<WorkflowSummary[]>;
  /** Load a workflow's metadata + file tree. */
  loadWorkflow(id: string): Promise<{ workflow: Workflow; tree: VaultNode }>;
  /** Open a folder picker, register it as a workflow. Null when dismissed. */
  addWorkflowFromFolder(): Promise<WorkflowSummary | null>;
  /**
   * Register a workflow from a path the writer typed.
   *
   * The escape hatch for a desktop where the native picker misbehaves — see
   * `vault_add_workflow_by_path` in `src-tauri/src/commands.rs`.
   */
  addWorkflowByPath(path: string): Promise<WorkflowSummary>;
  /**
   * Make a new workflow folder and register it. Opens a folder picker for the
   * parent location; null when the writer dismisses it.
   */
  createWorkflow(name: string, kind: WorkflowKind): Promise<WorkflowSummary | null>;
  /** Write the sample workflow to disk (or reopen it) and register it. */
  createSampleWorkflow(): Promise<WorkflowSummary>;
  /** Read a markdown / fountain / text file. */
  readFile(workflowId: string, relPath: string): Promise<string>;
  /** Resolve a binary asset (image, PDF, etc) to a renderable URL. */
  resolveAssetUrl(workflowId: string, relPath: string): Promise<string>;
  /** Read a binary asset's raw bytes (for PDF.js etc). */
  readBinary(workflowId: string, relPath: string): Promise<Uint8Array>;
  /** Write a file. */
  writeFile(workflowId: string, relPath: string, content: string): Promise<void>;
  /** Move a file into .aquarius/trash/ (30d retention metadata). */
  softDelete(workflowId: string, relPath: string): Promise<void>;
  /** Subscribe to FS changes within a workflow. Returns an unsubscribe fn. */
  watch(workflowId: string, onChange: () => void): () => void;
}
