import type { VaultNode, Workflow, WorkflowSummary } from "@/types/vault";

/** Vault service contract — implemented twice: browser-mock and tauri-fs. */
export interface VaultService {
  /** Workflows the user has connected (recent + active). */
  listWorkflows(): Promise<WorkflowSummary[]>;
  /** Load a workflow's metadata + file tree. */
  loadWorkflow(id: string): Promise<{ workflow: Workflow; tree: VaultNode }>;
  /** Open a folder picker, register it as a workflow. */
  addWorkflowFromFolder(): Promise<WorkflowSummary | null>;
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
