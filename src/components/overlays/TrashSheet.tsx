// Recently Deleted — web mirror of RecentlyDeletedSheet.swift. Deletes are
// captured by `trashFile` (lib/vault/aux) and restorable from here.
//
// Nothing in this sheet happens on a timer. Until 2026-08-31 the Rust side
// swept anything past 30 days on every workflow load, which meant a chapter
// could disappear for good while the writer was only opening a folder. Swift
// has never done that (SWIFT-AUDIT §4): it keeps everything until someone
// confirms "Empty trash", and that is now what this does too. The retention
// window survives as a *label* — an old row says so, and then stays.
import { useCallback, useEffect, useState } from "react";
import { Overlay } from "./Overlay";
import { useVault } from "@/state/vaultStore";
import {
  emptyTrash,
  listTrash,
  purgeTrashEntry,
  restoreTrash,
  trashRetentionDays,
  type TrashEntry,
} from "@/lib/vault/aux";
import { useEditor } from "@/state/editorStore";
import { useNotices } from "@/state/noticeStore";
import { EmptyState } from "@/components/shell/EmptyState";
import "./FindReplace.css";

const DAY_MS = 24 * 60 * 60 * 1000;

export function TrashSheet() {
  const { current, selectPath, addToTree } = useVault();
  const notices = useNotices();
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [retention, setRetention] = useState<number | null>(null);
  const [emptying, setEmptying] = useState(false);

  const reload = useCallback(() => {
    if (current) setEntries(listTrash(current.id));
  }, [current]);
  useEffect(reload, [reload]);

  // The window is the backend's number, asked for rather than repeated here.
  // It only decides a caption, so a failure to fetch it just means no caption.
  useEffect(() => {
    let alive = true;
    void trashRetentionDays()
      .then((d) => { if (alive) setRetention(d); })
      .catch(() => { /* no caption, no problem */ });
    return () => { alive = false; };
  }, []);

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

  // The one bulk destruction in the app. The count is in the question because
  // "Empty the trash?" and "Destroy 41 documents?" are not the same question.
  const empty = async () => {
    if (!current || entries.length === 0) return;
    const n = entries.length;
    const ok = window.confirm(
      `Permanently delete ${n} ${n === 1 ? "item" : "items"} from the trash?\n\n` +
      "This cannot be undone — the files are removed from disk, not moved.",
    );
    if (!ok) return;
    setEmptying(true);
    try {
      await emptyTrash(current.id);
      notices.say(`Trash emptied — ${n} ${n === 1 ? "item" : "items"} deleted for good`);
    } catch (e) {
      notices.fail("Could not empty the trash", e);
    } finally {
      setEmptying(false);
      reload();
    }
  };

  const cutoff = retention === null ? null : Date.now() - retention * DAY_MS;

  return (
    <Overlay title="Recently Deleted" width={560}>
      <div className="fr">
        {entries.length === 0 ? (
          <EmptyState
            art="folder"
            headline="The trash is empty"
            subline="Deleted documents wait here until you empty it — nothing is removed on a schedule."
          />
        ) : (
          <>
            <div className="fr-hits">
              {entries.map((t) => {
                const old = cutoff !== null && t.deletedAt < cutoff;
                return (
                  <div key={t.id} className="fr-hit">
                    <div className="fr-hit-main as-text">
                      <span className="fr-path">{t.path}</span>
                      <span className="fr-preview">
                        deleted {new Date(t.deletedAt).toLocaleString()}
                        {old && ` · kept past ${retention} days`}
                      </span>
                    </div>
                    <button className="fr-replace" onClick={() => void restore(t)}>Restore</button>
                    <button className="fr-replace danger" onClick={() => {
                      if (current && window.confirm(`Permanently delete "${t.path}" from trash?`)) {
                        purgeTrashEntry(current.id, t.id); reload();
                      }
                    }}>Purge</button>
                  </div>
                );
              })}
            </div>

            <div className="fr-foot">
              <span className="fr-foot-note">
                {retention === null
                  ? "Deletions are kept until you empty the trash."
                  : `Deletions are kept until you empty the trash. Anything past ${retention} days is marked, not removed.`}
              </span>
              <button
                className="fr-replace danger"
                onClick={() => void empty()}
                disabled={emptying}
              >
                {emptying ? "Emptying…" : "Empty trash"}
              </button>
            </div>
          </>
        )}
      </div>
    </Overlay>
  );
}
