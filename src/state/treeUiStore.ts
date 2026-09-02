// The sidebar tree's momentary UI state — which row owns the one open ⋯ menu,
// which row is being renamed in place, what is being dragged and where it is
// hovering, and which folder the writer last touched so "+" adds *there*.
//
// **Why a store and not `useState` in `Sidebar`.** Every row needs to know
// whether *it* is the row in question. Held in the Sidebar, that answer has to
// reach the rows either as a prop threaded down the recursion or as a context
// object — and both change identity for all sixteen rows the moment one of
// them changes, which is exactly what `React.memo` on a row cannot help with.
// In a store each row selects one boolean about itself
// (`s.menuFor === node.path`), so opening a menu re-renders the row that opened
// it and nothing else. docs/NOTES.md §27n has the numbers.
//
// Nothing here touches disk and nothing here is persisted: this is what the
// tree looks like this second, not what the vault contains. Where a file
// *lives* is `vaultStore`'s business, and stays there.
import { create } from "zustand";

interface TreeUiState {
  /** The row whose ⋯ menu is open, or null. Only ever one — two open menus is
   *  two ways to act on two different rows with one pointer. */
  menuFor: string | null;
  /** The row showing an inline rename field, or null. Also only ever one: two
   *  rename fields at once would be a way to lose an edit. */
  renaming: string | null;
  /** The row being carried, or null when no drag is in flight. */
  dragPath: string | null;
  /** The folder currently accepting the drop — "" is the vault root. */
  dragInto: string | null;
  /**
   * Where the writer last put their attention in the tree, so a new file lands
   * beside it.
   *
   * Deliberately not the vault's `selectedPath`: selecting a folder would put a
   * folder in the editor pane, which has nothing to render for one.
   */
  lastFolder: string | null;
  setMenuFor: (path: string | null) => void;
  setRenaming: (path: string | null) => void;
  setDragPath: (path: string | null) => void;
  setDragInto: (folder: string | null) => void;
  setLastFolder: (folder: string) => void;
}

export const useTreeUi = create<TreeUiState>((set) => ({
  menuFor: null,
  renaming: null,
  dragPath: null,
  dragInto: null,
  lastFolder: null,
  setMenuFor: (path) => set({ menuFor: path }),
  setRenaming: (path) => set({ renaming: path }),
  setDragPath: (path) => set({ dragPath: path }),
  setDragInto: (folder) => set({ dragInto: folder }),
  setLastFolder: (folder) => set({ lastFolder: folder }),
}));
