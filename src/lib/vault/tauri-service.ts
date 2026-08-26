import type { VaultService } from "./service";
import type { VaultNode, Workflow, WorkflowSummary } from "@/types/vault";

// Tauri FS-backed implementation. Skeleton — Phase 1.5 fills these in once
// the FS plugin is wired up. For now it throws loudly so we know when we're
// running in the shell without the implementation ready.

function nyi(name: string): never {
  throw new Error(`tauri vault service: ${name}() not implemented yet`);
}

export function createTauriVaultService(): VaultService {
  return {
    async listWorkflows(): Promise<WorkflowSummary[]> { return nyi("listWorkflows"); },
    async loadWorkflow(_id): Promise<{ workflow: Workflow; tree: VaultNode }> { return nyi("loadWorkflow"); },
    async addWorkflowFromFolder() { return nyi("addWorkflowFromFolder"); },
    async readFile(_workflowId, _relPath) { return nyi("readFile"); },
    async resolveAssetUrl(_workflowId, _relPath) { return nyi("resolveAssetUrl"); },
    async readBinary(_workflowId, _relPath) { return nyi("readBinary"); },
    async writeFile(_workflowId, _relPath, _content) { return nyi("writeFile"); },
    async softDelete(_workflowId, _relPath) { return nyi("softDelete"); },
    watch(_workflowId, _onChange) { return () => {}; },
  };
}
