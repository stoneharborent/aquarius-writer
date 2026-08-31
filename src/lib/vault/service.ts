import type {
  EntryReport,
  NewFileKind,
  VaultNode,
  Workflow,
  WorkflowKind,
  WorkflowSummary,
} from "@/types/vault";

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
  /**
   * Create a document inside `parent` (`""` for the vault root), seeded with
   * the frontmatter or title page its kind expects. A name that is already
   * taken gets a " 2" / " 3" suffix — this never overwrites.
   */
  createFile(
    workflowId: string,
    parent: string,
    name: string,
    kind: NewFileKind,
  ): Promise<EntryReport>;
  /** Create an empty folder inside `parent` (`""` for the vault root). */
  createFolder(workflowId: string, parent: string, name: string): Promise<EntryReport>;
  /**
   * Rename a file or folder in place. `newName` is one path segment; a
   * document keeps its extension unless the new name carries one.
   */
  rename(workflowId: string, relPath: string, newName: string): Promise<EntryReport>;
  /**
   * Move a file or folder into `destFolder` (`""` for the vault root), keeping
   * its name. The bytes are not rewritten, and the document's version history
   * and comments follow it.
   */
  move(workflowId: string, relPath: string, destFolder: string): Promise<EntryReport>;
  /** Move a file into .aquarius/trash/ (30d retention metadata). */
  softDelete(workflowId: string, relPath: string): Promise<void>;
  /** Subscribe to FS changes within a workflow. Returns an unsubscribe fn. */
  watch(workflowId: string, onChange: () => void): () => void;
}
