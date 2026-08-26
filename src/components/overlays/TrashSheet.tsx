// Recently Deleted — web mirror of RecentlyDeletedSheet.swift. Deletes are
// captured by `trashFile` (lib/vault/aux) and restorable from here.
import { useCallback, useEffect, useState } from "react";
import { Overlay } from "./Overlay";
import { useVault } from "@/state/vaultStore";
import {
  listTrash,
  purgeTrashEntry,
  restoreTrash,
  type TrashEntry,
} from "@/lib/vault/aux";
import { useEditor } from "@/state/editorStore";
import "./FindReplace.css";

export function TrashSheet() {
  const { current, selectPath, addToTree } = useVault();
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const reload = useCallback(() => {
    if (current) setEntries(listTrash(current.id));
  }, [current]);
  useEffect(reload, [reload]);

  const restore = async (t: TrashEntry) => {
    if (!current) return;
    const path = await restoreTrash(current.id, t.id);
    reload();
    if (path) {
      // Drop any stale open copy so the editor reloads the restored text.
      useEditor.getState().evict(path);
      addToTree(path);
      selectPath(path);
    }
  };

  return (
    <Overlay title="Recently Deleted" width={560}>
      <div className="fr">
        {entries.length === 0 && (
          <p className="fr-idle">Trash is empty. Deleted documents land here and can be restored.</p>
        )}
        <div className="fr-hits">
          {entries.map((t) => (
            <div key={t.id} className="fr-hit">
              <div className="fr-hit-main as-text">
                <span className="fr-path">{t.path}</span>
                <span className="fr-preview">
                  deleted {new Date(t.deletedAt).toLocaleString()}
                </span>
              </div>
              <button className="fr-replace" onClick={() => void restore(t)}>Restore</button>
              <button className="fr-replace danger" onClick={() => {
                if (current && window.confirm(`Permanently delete "${t.path}" from trash?`)) {
                  purgeTrashEntry(current.id, t.id); reload();
                }
              }}>Purge</button>
            </div>
          ))}
        </div>
      </div>
    </Overlay>
  );
}
