// The top bar — SWIFT-AUDIT §1.3, the row the port never had.
//
// Files toggle · ⌘K search capsule · the editor toolbar, centred · the
// right-pane buttons. The toolbar used to sit inside each editor pane; the
// pane now publishes its context to `toolbarStore` and this row draws it, so
// prose, note and screenplay all get the same one row in the same place.
import { useEffect, useRef } from "react";
import { EditorToolbar } from "@/components/editors/EditorToolbar";
import { PanelRightIcon, SearchIcon, SidebarIcon } from "@/icons";
import { useOverlay } from "@/state/overlayStore";
import { useShell } from "@/state/shellStore";
import { useToolbar } from "@/state/toolbarStore";
import "./TopBar.css";

export function TopBar() {
  // Field-by-field rather than the whole store: the column widths change on
  // every frame of a splitter drag, and this row does not care about them.
  const sidebarCollapsed = useShell((s) => s.sidebarCollapsed);
  const rightCollapsed = useShell((s) => s.rightCollapsed);
  const rightTab = useShell((s) => s.rightTab);
  const query = useShell((s) => s.query);
  const focusTick = useShell((s) => s.focusTick);
  const toggleSidebar = useShell((s) => s.toggleSidebar);
  const toggleRightTab = useShell((s) => s.toggleRightTab);
  const setQuery = useShell((s) => s.setQuery);
  const { kind, path, element } = useToolbar();
  const overlay = useOverlay();
  const search = useRef<HTMLInputElement>(null);

  // ⌘K bumps `focusTick`; skip the first render so the app does not open with
  // the caret parked in the search field.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    search.current?.focus();
    search.current?.select();
  }, [focusTick]);

  const paneOn = (tab: "comments" | "versions") => !rightCollapsed && rightTab === tab;

  return (
    <div className="topbar">
      <div className="tb-left">
        <button
          className={`tb-btn${sidebarCollapsed ? "" : " on"}`}
          title="Files (⌘\)"
          aria-pressed={!sidebarCollapsed}
          onClick={toggleSidebar}
        >
          <SidebarIcon size={14} />
          <span className="tb-btn-text">Files</span>
        </button>

        <div className="tb-search">
          <SearchIcon size={13} color="var(--ink-mute)" />
          <input
            ref={search}
            className="tb-search-input"
            type="text"
            value={query}
            placeholder="Search files…"
            aria-label="Search files"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Enter hands the same words to the full-text search, which is
              // the other half of "find" and the thing a filtered tree cannot
              // do: look inside the documents.
              if (e.key === "Enter" && query.trim().length >= 2) {
                overlay.open("find", { query: query.trim() });
              }
              if (e.key === "Escape") {
                setQuery("");
                e.currentTarget.blur();
              }
            }}
          />
          {query
            ? (
              <button className="tb-search-clear" title="Clear" onClick={() => setQuery("")}>
                ✕
              </button>
            )
            : <span className="tb-keycap">⌘K</span>}
        </div>
      </div>

      <div className="tb-center">
        {kind && path && (
          <EditorToolbar
            kind={kind}
            path={path}
            activeElement={element}
            variant="inline"
          />
        )}
      </div>

      <div className="tb-right">
        <button
          className={`tb-btn${paneOn("comments") ? " on" : ""}`}
          title="Comments (⌘⌥\)"
          aria-pressed={paneOn("comments")}
          onClick={() => toggleRightTab("comments")}
        >
          <span className="tb-btn-text">Comments</span>
        </button>
        <button
          className={`tb-btn${paneOn("versions") ? " on" : ""}`}
          title="Versions (⌘⌥\)"
          aria-pressed={paneOn("versions")}
          onClick={() => toggleRightTab("versions")}
        >
          <span className="tb-btn-text">Versions</span>
        </button>
        <button
          className="tb-btn tb-icon-only"
          title={rightCollapsed ? "Show the right pane" : "Hide the right pane"}
          onClick={() => useShell.getState().setRightCollapsed(!rightCollapsed)}
        >
          <PanelRightIcon size={14} />
        </button>
      </div>
    </div>
  );
}
