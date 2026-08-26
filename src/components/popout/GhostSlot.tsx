import { usePopout } from "@/state/popoutStore";
import { useVault } from "@/state/vaultStore";
import "./GhostSlot.css";

/** Shown in the host where a popped-out doc used to be — so the writer
 * never loses track of where their work went. ⌃⌘O reattaches. */
export function GhostSlot({ path }: { path: string }) {
  const reattach = usePopout((s) => s.reattach);
  const tree = useVault((s) => s.tree);
  const fileName = path.split("/").pop() ?? path;
  const node = findNode(tree, path);
  const title = (node?.frontmatter?.title as string | undefined) ?? fileName;

  return (
    <div className="ghost-slot">
      <div className="ghost-eyebrow">Detached window</div>
      <div className="ghost-title">{title}</div>
      <div className="ghost-path">{path}</div>
      <button className="ghost-reattach" onClick={() => reattach(path)}>
        ⌃⌘O · reattach to host
      </button>
      <div className="ghost-hint">
        The editor for this doc is open in a separate window. Close that window or click reattach to bring it back here.
      </div>
    </div>
  );
}

function findNode(node: import("@/types/vault").VaultNode | null, path: string): import("@/types/vault").VaultNode | null {
  if (!node) return null;
  if (node.path === path) return node;
  if (!node.children) return null;
  for (const c of node.children) {
    const hit = findNode(c, path);
    if (hit) return hit;
  }
  return null;
}
