import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { ChapterRail } from "@/components/rails/ChapterRail";
import { ScenesRail } from "@/components/rails/ScenesRail";
import { ProseEditor } from "@/components/editors/prose/ProseEditor";
import { NoteEditor } from "@/components/editors/note/NoteEditor";
import { ScreenplayEditor } from "@/components/editors/screenplay/ScreenplayEditor";
import { TitlePageEditor } from "@/components/editors/screenplay/TitlePage";
import { paginate } from "@/lib/markdown/fountain-smart";
import { movePermutation, reorderScenes } from "@/lib/markdown/fountain-scenes";
import { countWords } from "@/lib/words";
import { ImageViewer } from "@/components/viewers/ImageViewer";
import { PdfViewer } from "@/components/viewers/PdfViewer";
import { HtmlViewer } from "@/components/viewers/HtmlViewer";
import { VideoViewer } from "@/components/viewers/VideoViewer";
import { SPLIT_MIN, useSplit, type SplitPane } from "@/state/splitStore";
import { GhostSlot } from "@/components/popout/GhostSlot";
import { usePopout } from "@/state/popoutStore";
import { Backlinks } from "@/components/notes/Backlinks";
import { ManuscriptView } from "@/components/manuscript/ManuscriptView";
import { RightPane } from "@/components/rightpane/RightPane";
import { TopBar } from "@/components/shell/TopBar";
import { Gutter } from "@/components/shell/Gutter";
import { Splitter } from "@/components/shell/Splitter";
import { EmptyState } from "@/components/shell/EmptyState";
import { useVault } from "@/state/vaultStore";
import { useEditor } from "@/state/editorStore";
import { useOverlay } from "@/state/overlayStore";
import { useToolbar } from "@/state/toolbarStore";
import {
  EDITOR_MIN, GUTTER,
  RIGHT_DEFAULT, RIGHT_MIN, RIGHT_TAB_LABEL,
  SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
  useShell,
} from "@/state/shellStore";
import { collectScenes, parseTitleBlock } from "@/lib/fountain";
import { useDeferredText } from "@/lib/defer";
import type { ChapterStatus } from "@/types/vault";
import "./MainWindow.css";

export function MainWindow() {
  const { view } = useVault();
  const {
    sidebarWidth, sidebarCollapsed, setSidebarWidth, setSidebarCollapsed,
    rightWidth, rightCollapsed, rightTab, setRightWidth, setRightCollapsed,
  } = useShell();
  const host = useRef<HTMLDivElement>(null);

  /**
   * The editor never shrinks past 320px because the window did (SWIFT-AUDIT
   * §1.3). When it would, the right pane gives ground first and the sidebar
   * second — the sidebar is the one you navigate with.
   */
  useEffect(() => {
    const el = host.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const total = el.clientWidth;
      if (!total) return;
      const s = useShell.getState();
      const sw = s.sidebarCollapsed ? GUTTER : s.sidebarWidth;
      const rw = s.rightCollapsed ? GUTTER : s.rightWidth;
      const rules = (s.sidebarCollapsed ? 0 : 1) + (s.rightCollapsed ? 0 : 1);
      let deficit = EDITOR_MIN - (total - sw - rw - rules);
      if (deficit <= 0) return;
      if (!s.rightCollapsed) {
        const next = Math.max(RIGHT_MIN, s.rightWidth - deficit);
        deficit -= s.rightWidth - next;
        if (next !== s.rightWidth) s.setRightWidth(next);
      }
      if (deficit > 0 && !s.sidebarCollapsed) {
        const next = Math.max(SIDEBAR_MIN, s.sidebarWidth - deficit);
        if (next !== s.sidebarWidth) s.setSidebarWidth(next);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The template is built from what is actually rendered below — a collapsed
  // pane drops its splitter track as well as its width, so the two stay in
  // step and a hidden splitter can never be grabbed.
  const columns = [
    sidebarCollapsed ? `${GUTTER}px` : `${sidebarWidth}px`,
    ...(sidebarCollapsed ? [] : ["1px"]),
    "minmax(0, 1fr)",
    ...(rightCollapsed ? [] : ["1px"]),
    rightCollapsed ? `${GUTTER}px` : `${rightWidth}px`,
  ].join(" ");

  /** Room the sidebar may take before the editor drops below its minimum. */
  const sidebarCeiling = () => {
    const total = host.current?.clientWidth ?? 0;
    const rw = rightCollapsed ? GUTTER : rightWidth;
    const rules = 1 + (rightCollapsed ? 0 : 1);
    return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, total - rw - rules - EDITOR_MIN));
  };

  const rightCeiling = () => {
    const total = host.current?.clientWidth ?? 0;
    const sw = sidebarCollapsed ? GUTTER : sidebarWidth;
    const rules = 1 + (sidebarCollapsed ? 0 : 1);
    return Math.max(RIGHT_MIN, total - sw - rules - EDITOR_MIN);
  };

  return (
    <div className="main-window">
      <TopBar />

      <div className="mw-columns" ref={host} style={{ gridTemplateColumns: columns }}>
        {sidebarCollapsed
          ? <Gutter label="Files" side="right" onOpen={() => setSidebarCollapsed(false)} />
          : <Sidebar />}

        {!sidebarCollapsed && (
          <Splitter
            label="Resize the file sidebar"
            onReset={() => setSidebarWidth(SIDEBAR_DEFAULT)}
            onDrag={(clientX) => {
              const left = host.current?.getBoundingClientRect().left ?? 0;
              setSidebarWidth(Math.min(sidebarCeiling(), clientX - left));
            }}
          />
        )}

        <main className="mw-editor">
          {view !== "editor" ? <ManuscriptView /> : <SplitHost />}
        </main>

        {!rightCollapsed && (
          <Splitter
            label="Resize the comments and versions pane"
            onReset={() => setRightWidth(RIGHT_DEFAULT)}
            onDrag={(clientX) => {
              const right = host.current?.getBoundingClientRect().right ?? 0;
              setRightWidth(Math.min(rightCeiling(), right - clientX));
            }}
          />
        )}

        {/* The gutter names what will come back, not what came first — a
            writer who put a terminal away should not be offered "Comments". */}
        {rightCollapsed
          ? <Gutter label={RIGHT_TAB_LABEL[rightTab]} side="left"
              onOpen={() => setRightCollapsed(false)} />
          : <RightPane />}
      </div>
    </div>
  );
}

/**
 * The editor column: one document, or two side by side (PARITY row 11).
 *
 * Both panes are real editors over real `editorStore` buffers — same debounce,
 * same conflict guard, independent carets, scroll positions and undo stacks,
 * because they are two CodeMirror views over two different documents. What
 * they are *not* allowed to be is two views over the SAME document: see
 * `sameDoc` below and NOTES §25b.
 */
function SplitHost() {
  const selectedPath = useVault((s) => s.selectedPath);
  const isPopped = usePopout((s) => (selectedPath ? s.popped.has(selectedPath) : false));
  const secondaryPath = useSplit((s) => s.secondaryPath);
  const reference = useSplit((s) => s.reference);
  const active = useSplit((s) => s.active);
  const ratio = useSplit((s) => s.ratio);
  const secondaryPopped = usePopout((s) => (secondaryPath ? s.popped.has(secondaryPath) : false));

  const host = useRef<HTMLDivElement>(null);
  const [hostWidth, setHostWidth] = useState(0);

  // Measured before paint: an effect would show one frame at 50/50 before the
  // persisted ratio arrived, which reads as the divider jumping on open.
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    setHostWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setHostWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Picking a file in the sidebar loads it into the PRIMARY pane, so that is
  // where the writer now is — the accent line and the toolbar follow.
  useEffect(() => {
    if (selectedPath) useSplit.getState().setActive("primary");
  }, [selectedPath]);

  /**
   * The same document in both panes.
   *
   * Two CodeMirror views cannot share one `EditorState`, and two views fed by
   * one `editorStore` buffer fight: each one's `value` sync would replace the
   * other's whole document on every keystroke, wiping its selection and its
   * undo history. So the honest answer is the simple one — the second copy is
   * a read-only look at the same buffer, and says so in its header.
   */
  const sameDoc = !!secondaryPath && secondaryPath === selectedPath;
  const secondaryReadOnly = reference || sameDoc;
  const split = !!secondaryPath;

  /**
   * Whole-pixel geometry (NOTES §1a): the divider hands out integer pixel
   * widths, never a transform and never a fractional track. `1fr` on the right
   * takes the integer remainder of an integer container.
   */
  const columns = (() => {
    if (!split) return "minmax(0, 1fr)";
    const available = hostWidth - 1; // the divider's own 1px track
    if (available <= 0) return "minmax(0, 1fr) 1px minmax(0, 1fr)";
    // Too narrow to give both panes their minimum: split it down the middle
    // and let both be cramped equally. Still integers — `1fr 1px 1fr` on an
    // odd remainder hands each pane a half pixel, which is the one thing the
    // metrics contract does not allow.
    const left = available < SPLIT_MIN * 2
      ? Math.floor(available / 2)
      : Math.round(Math.min(available - SPLIT_MIN, Math.max(SPLIT_MIN, available * ratio)));
    return `${left}px 1px minmax(0, 1fr)`;
  })();

  /** Clicking or tabbing into a pane is what makes it the active one. */
  const claim = (pane: SplitPane) => ({
    onPointerDownCapture: () => useSplit.getState().setActive(pane),
    onFocusCapture: () => useSplit.getState().setActive(pane),
  });

  const paneClass = (pane: SplitPane, extra = "") =>
    ["mw-pane", extra, split && active === pane ? "mw-pane-active" : ""]
      .filter(Boolean).join(" ");

  return (
    <div className="mw-split-host" ref={host} style={{ gridTemplateColumns: columns }}>
      <section className={paneClass("primary")} {...claim("primary")}>
        {selectedPath && isPopped
          ? <GhostSlot path={selectedPath} />
          : <DocView path={selectedPath} pane="primary" />}
      </section>

      {split && (
        <Splitter
          label="Resize the split editor"
          onReset={() => useSplit.getState().resetRatio()}
          onDrag={(clientX) => {
            const rect = host.current?.getBoundingClientRect();
            if (!rect) return;
            const available = Math.round(rect.width) - 1;
            if (available < SPLIT_MIN * 2) return;
            const x = Math.min(
              available - SPLIT_MIN,
              Math.max(SPLIT_MIN, clientX - rect.left),
            );
            useSplit.getState().setRatio(x / available);
          }}
        />
      )}

      {secondaryPath && (
        <section
          className={paneClass("secondary", "mw-pane-secondary")}
          {...claim("secondary")}
        >
          <header className="mw-pane-head">
            <span className="mw-pane-crumb" title={secondaryPath}>{secondaryPath}</span>
            {sameDoc && (
              <span className="mw-pane-note">already open in the other pane</span>
            )}
            <div className="mw-pane-modes" role="group" aria-label="Split pane mode">
              <button
                className={`mw-mode-btn${secondaryReadOnly ? "" : " on"}`}
                title={sameDoc
                  ? "This document is already open in the other pane"
                  : "Edit this document here"}
                aria-pressed={!secondaryReadOnly}
                disabled={sameDoc}
                onClick={() => useSplit.getState().setReference(false)}
              >Edit</button>
              <button
                className={`mw-mode-btn${secondaryReadOnly ? " on" : ""}`}
                title="Reference — read-only"
                aria-pressed={secondaryReadOnly}
                onClick={() => useSplit.getState().setReference(true)}
              >Reference</button>
            </div>
            <button
              className="mw-mode-btn"
              title="Close split"
              onClick={() => useSplit.getState().closeSplit()}
            >✕</button>
          </header>
          <div className="mw-pane-body">
            {secondaryPopped
              ? <GhostSlot path={secondaryPath} />
              : (
                <DocView
                  // Reference mode is read at mount, so the toggle remounts the
                  // editor — and a document that stops being editable also
                  // loses the undo history that belonged to editing it.
                  key={`${secondaryPath}|${secondaryReadOnly ? "ref" : "edit"}`}
                  path={secondaryPath}
                  pane="secondary"
                  readOnly={secondaryReadOnly}
                />
              )}
          </div>
        </section>
      )}
    </div>
  );
}

/** One document rendered by kind — shared by the primary and split panes. */
function DocView({ path, pane = "primary", readOnly = false }: {
  path: string | null; pane?: SplitPane; readOnly?: boolean;
}) {
  const secondary = pane === "secondary";
  const { current, selectPath, setView, reorderChapters, activeDraftId } = useVault();
  const draft = current?.drafts.find((d) => d.id === activeDraftId) ?? current?.drafts[0];
  const chapters = draft?.chapterOrder ?? current?.manuscripts[0]?.chapterOrder ?? [];
  const isChapter = path ? chapters.includes(path) : false;

  if (!path || !current) return <EditorPlaceholder selectedPath={path} />;

  if (isChapter) {
    return (
      <div className="mw-editor-split">
        {!secondary && (
          <ChapterRail
            chapters={chapters}
            selected={path}
            onSelect={selectPath}
            onReorder={reorderChapters}
          />
        )}
        <div className="mw-prose-wrap">
          {!secondary && (
            <div className="mw-prose-modes">
              <button className="mw-mode-btn" onClick={() => setView("outline")}>
                Outline
              </button>
              <button className="mw-mode-btn" onClick={() => setView("corkboard")}>
                Cards
              </button>
            </div>
          )}
          <ProsePane
            key={path}
            workflowId={current.id}
            path={path}
            pane={pane}
            readOnly={readOnly}
          />
        </div>
      </div>
    );
  }
  if (/\.(jpe?g|png|gif|webp|svg|bmp)$/i.test(path)) {
    return <ImageViewer key={path} workflowId={current.id} path={path} />;
  }
  if (/\.pdf$/i.test(path)) {
    return <PdfViewer key={path} workflowId={current.id} path={path} />;
  }
  if (/\.(html?)$/i.test(path)) {
    return <HtmlViewer key={path} workflowId={current.id} path={path} />;
  }
  if (/\.(mp4|mov|webm|m4v)$/i.test(path)) {
    return <VideoViewer key={path} workflowId={current.id} path={path} />;
  }
  if (path.endsWith(".fountain")) {
    return (
      <ScreenplayPane
        key={path} workflowId={current.id} path={path} pane={pane} readOnly={readOnly}
      />
    );
  }
  if (path.endsWith(".md")) {
    return (
      <NotePane
        key={path} workflowId={current.id} path={path} pane={pane} readOnly={readOnly}
      />
    );
  }
  return <EditorPlaceholder selectedPath={path} />;
}

/**
 * Tell the top bar which document its toolbar is driving, and answer whether
 * this pane is the one driving it.
 *
 * There is one toolbar row for the window, so exactly one pane may own it: the
 * **active** one (splitStore's `active`, set by clicking or tabbing into a
 * pane). Before the split became editable only the primary ever spoke, which
 * was right when the second pane could not be typed in and is wrong now — ⌘B
 * has to bold the paragraph the caret is actually in.
 *
 * A read-only reference pane never claims the row: there is nothing there for
 * a format command to do.
 *
 * The hand-off is safe in both directions because React runs every effect
 * *cleanup* in a commit before any effect *setup* — the pane losing the row
 * clears it before the pane gaining it writes.
 */
function useToolbarContext(
  kind: "md" | "fountain", path: string, pane: SplitPane, readOnly: boolean,
): boolean {
  const drives = useSplit((s) => s.active === pane) && !readOnly;
  useEffect(() => {
    if (!drives) return;
    useToolbar.getState().setContext(kind, path);
    return () => useToolbar.getState().clear(path);
  }, [kind, path, drives]);
  return drives;
}

function ProsePane({ workflowId, path, pane = "primary", readOnly = false }: {
  workflowId: string; path: string; pane?: SplitPane; readOnly?: boolean;
}) {
  // Select THIS document, not the whole store. `useEditor()` with no selector
  // re-renders on every keystroke in every open buffer — the other split pane,
  // a popout, anything — because `edit` replaces the `docs` map wholesale.
  const doc = useEditor((s) => s.docs[path]);
  const open = useEditor((s) => s.open);
  const edit = useEditor((s) => s.edit);
  const secondary = pane === "secondary";

  useEffect(() => {
    void open(workflowId, path);
  }, [workflowId, path, open]);

  useToolbarContext("md", path, pane, readOnly);

  const status = doc?.status ?? "clean";
  const fmStatus = doc?.frontmatter?.status as ChapterStatus | undefined;

  return (
    <article className="mw-prose mw-canvas">
      {/* No duplicate chrome in the split pane: the path, the mode toggle and
          the close button are already in the slim pane header above it. */}
      <header className="mw-prose-head">
        <span className="mw-prose-crumb">{secondary ? "" : path}</span>
        {fmStatus && (
          <span className={`mw-status mw-status-${fmStatus}`}>{fmStatus}</span>
        )}
        <SaveBadge status={status} />
        {!secondary && <SplitButton path={path} />}
        {!secondary && <PopoutButton path={path} />}
      </header>
      <div className="mw-sheet">
        <h1 className="mw-prose-title">
          {(doc?.frontmatter?.title as string | undefined) ?? path}
        </h1>
        <div className="mw-prose-editor">
          {doc ? (
            <ProseEditor
              value={doc.body}
              onChange={readOnly ? noop : (v) => edit(path, v)}
              path={path}
              readOnly={readOnly}
            />
          ) : (
            <p className="mw-prose-loading">Loading…</p>
          )}
        </div>
        <footer className="mw-prose-foot">
          <FooterStats text={doc?.body ?? ""} />
        </footer>
      </div>
    </article>
  );
}

/** A reference pane's editor reports no changes; nothing is listening. */
const noop = () => {};

/** Words · characters · read time — parity with EditorFooterStats.swift. */
function FooterStats({ text, extra }: { text: string; extra?: React.ReactNode }) {
  // Words and characters are slow-moving numbers in a footer and both are
  // O(document); neither can visibly change mid-word. Counting them inside the
  // render a keypress triggers put a full scan of the chapter on the typing
  // path (docs/NOTES.md §27l).
  const settled = useDeferredText(text);
  const words = useMemo(() => countWords(settled), [settled]);
  const chars = settled.length;
  const minutes = Math.max(1, Math.round(words / 230));
  return (
    <>
      {extra}
      <span>{words.toLocaleString()} words</span>
      <span>{chars.toLocaleString()} chars</span>
      <span>~{minutes} min read</span>
    </>
  );
}

function ScreenplayPane({ workflowId, path, pane = "primary", readOnly = false }: {
  workflowId: string; path: string; pane?: SplitPane; readOnly?: boolean;
}) {
  // Select THIS document, not the whole store. `useEditor()` with no selector
  // re-renders on every keystroke in every open buffer — the other split pane,
  // a popout, anything — because `edit` replaces the `docs` map wholesale.
  const doc = useEditor((s) => s.docs[path]);
  const open = useEditor((s) => s.open);
  const edit = useEditor((s) => s.edit);
  const secondary = pane === "secondary";

  useEffect(() => {
    void open(workflowId, path);
  }, [workflowId, path, open]);

  const drivesToolbar = useToolbarContext("fountain", path, pane, readOnly);

  // Live, and deliberately cheap: ONE title-block parse and two slices. This
  // used to parse the block twice — `splitTitlePage` does it internally, and
  // `titleBlockText` did it again — and index every scene in the document, all
  // inside the keystroke (docs/NOTES.md §27l). `titlePage` is gone because
  // nothing here read it; the Title Page tab edits `doc.body` directly.
  const parsed = useMemo(() => {
    const raw = doc?.body ?? "";
    const block = raw ? parseTitleBlock(raw) : null;
    if (!block?.present) return { body: raw, titleBlockText: "" };
    return { body: raw.slice(block.length), titleBlockText: raw.slice(0, block.length) };
  }, [doc?.body]);

  // The scene rail, the page count and the word count are each O(document) and
  // none of them can change mid-word, so they run off a settled copy of the
  // body instead of inside every keystroke.
  const settledBody = useDeferredText(parsed.body);
  const scenes = useMemo(() => collectScenes(settledBody), [settledBody]);

  const [activeScene, setActiveScene] = useState<number | null>(0);
  const [pageCount, setPageCount] = useState<number | null>(null);
  /** Script / Title Page — SWIFT-AUDIT §2.1's "second tab on the same file". */
  const [tab, setTab] = useState<"script" | "title">("script");
  const surface = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (settledBody) setPageCount(paginate(settledBody.split("\n")).pageCount);
  }, [settledBody]);

  // Coming back from the Title Page tab, the script editor has spent that time
  // in a `display: none` subtree where everything measures as zero. Tell
  // CodeMirror to rebuild its height map before the writer clicks in it — see
  // `remeasure` in ScreenplayEditor and NOTES §1a.
  useEffect(() => {
    if (tab !== "script") return;
    const host = surface.current?.querySelector<HTMLDivElement>(".screenplay-editor");
    (host as (HTMLDivElement & { __screenplayMeasure?: () => void }) | null)
      ?.__screenplayMeasure?.();
  }, [tab]);

  function handleSceneSelect(idx: number) {
    setActiveScene(idx);
    // Indexed off the LIVE body, not the settled copy the rail is drawn from:
    // a click inside the settle window must still scroll to where the scene
    // actually is now.
    const scene = collectScenes(parsed.body)[idx];
    if (!scene) return;
    // Scoped to THIS pane. A document-wide query would scroll whichever
    // screenplay happens to be first in the DOM, which stopped being "the only
    // one" the moment the split became a second editor.
    const host = surface.current?.querySelector<HTMLDivElement>(".screenplay-editor");
    const fn = (host as HTMLDivElement & { __screenplayScroll?: (n: number) => void } | null)?.__screenplayScroll;
    fn?.(scene.from);
  }

  /**
   * A scene dragged in the rail rewrites the script.
   *
   * The rewrite is `reorderScenes`, the renderer's mirror of the Rust
   * `vault::fountain::reorder_scenes` the MCP tool calls — one behaviour, two
   * doors. It goes back in through `handleBodyEdit`, so it is a normal buffer
   * edit: undoable in the editor's own history, debounced, and saved through
   * the conflict guard like a keystroke. A refused permutation changes nothing
   * and says so rather than half-applying.
   */
  function handleSceneReorder(from: number, to: number) {
    if (readOnly) return;
    // Live scenes again: a permutation built from a stale index would move the
    // wrong span of a document the writer has typed into since.
    const live = collectScenes(parsed.body);
    const result = reorderScenes(
      parsed.body,
      movePermutation(live.length, from, to),
    );
    if ("error" in result) {
      console.warn(`[screenplay] scene reorder refused: ${result.error}`);
      return;
    }
    handleBodyEdit(result.text);
    setActiveScene(to);
  }

  function handleBodyEdit(nextBody: string) {
    // Reassemble title block + edited body before pushing to the editor store.
    edit(path, parsed.titleBlockText + nextBody);
  }

  const wordCount = useMemo(
    () => (settledBody ? countWords(settledBody) : 0),
    [settledBody],
  );
  const status = doc?.status ?? "clean";

  return (
    <div className="mw-editor-split" ref={surface}>
      {/* The scenes rail is window chrome, not part of the document — the
          split pane does without it, the way it does without the chapter
          rail. */}
      {!secondary && (
        <ScenesRail
          scenes={scenes}
          activeIndex={activeScene}
          onSelect={handleSceneSelect}
          onReorder={readOnly ? undefined : handleSceneReorder}
        />
      )}
      {/* The screenplay is a paged canvas now (PARITY row 12): a desk, and real
          US-Letter sheets drawn from the point geometry in
          `screenplay-metrics.ts`. It does NOT use `.mw-sheet` — that is the
          prose canvas's one continuous page, and a screenplay's sheets are
          painted inside the CodeMirror content box so the text and the page
          edges cannot drift apart. */}
      <article className="mw-prose mw-screenplay">
        <header className="mw-prose-head">
          <span className="mw-prose-crumb">{secondary ? "" : path}</span>
          {!secondary && (
            <div className="mw-tabs" role="tablist" aria-label="Screenplay views">
              <button
                className={`mw-tab${tab === "script" ? " active" : ""}`}
                role="tab" aria-selected={tab === "script"}
                onClick={() => setTab("script")}
              >
                Script
              </button>
              <button
                className={`mw-tab${tab === "title" ? " active" : ""}`}
                role="tab" aria-selected={tab === "title"}
                onClick={() => setTab("title")}
              >
                Title Page
              </button>
            </div>
          )}
          {!secondary && (
            <button className="mw-mode-btn" title="Print-layout preview"
              onClick={() => useOverlay.getState().open("screenplay-preview", { path })}>
              Preview
            </button>
          )}
          <SaveBadge status={status} />
          {!secondary && <SplitButton path={path} />}
        </header>
        {/* The script editor is never unmounted by the tab switch — a
            CodeMirror teardown would take the undo history, the caret and the
            per-pane zoom registration with it, and the writer would come back
            from the title page to a document that had forgotten them. */}
        <div className="mw-prose-editor" hidden={tab !== "script"}>
          {doc ? (
            <ScreenplayEditor
              value={parsed.body}
              onChange={readOnly ? noop : handleBodyEdit}
              path={path}
              readOnly={readOnly}
              // The lit element pill belongs to whichever pane the caret is in.
              onElement={(el) => { if (drivesToolbar) useToolbar.getState().setElement(el); }}
              onPageCount={setPageCount}
            />
          ) : (
            <p className="mw-prose-loading">Loading…</p>
          )}
        </div>
        {tab === "title" && doc && (
          <div className="mw-prose-editor">
            <TitlePageEditor
              value={doc.body}
              onChange={(next) => edit(path, next)}
              readOnly={readOnly}
            />
          </div>
        )}
        <footer className="mw-prose-foot">
          <span>{scenes.length} scenes</span>
          {pageCount !== null && <span>{pageCount} {pageCount === 1 ? "page" : "pages"}</span>}
          <span>{wordCount.toLocaleString()} words</span>
        </footer>
      </article>
    </div>
  );
}

function NotePane({ workflowId, path, pane = "primary", readOnly = false }: {
  workflowId: string; path: string; pane?: SplitPane; readOnly?: boolean;
}) {
  // Select THIS document, not the whole store. `useEditor()` with no selector
  // re-renders on every keystroke in every open buffer — the other split pane,
  // a popout, anything — because `edit` replaces the `docs` map wholesale.
  const doc = useEditor((s) => s.docs[path]);
  const open = useEditor((s) => s.open);
  const edit = useEditor((s) => s.edit);
  const secondary = pane === "secondary";

  useEffect(() => {
    void open(workflowId, path);
  }, [workflowId, path, open]);

  useToolbarContext("md", path, pane, readOnly);

  const status = doc?.status ?? "clean";
  const title = (doc?.frontmatter?.title as string | undefined)
    ?? path.split("/").pop()?.replace(/\.md$/, "")
    ?? path;

  return (
    <article className="mw-prose mw-note mw-canvas">
      <header className="mw-prose-head">
        <span className="mw-prose-crumb">{secondary ? "" : path}</span>
        <SaveBadge status={status} />
        {!secondary && <SplitButton path={path} />}
        {!secondary && <PopoutButton path={path} />}
      </header>
      <div className="mw-sheet">
        <h1 className="mw-prose-title">{title}</h1>
        <div className="mw-prose-editor">
          {doc ? (
            <NoteEditor
              value={doc.body}
              onChange={readOnly ? noop : (v) => edit(path, v)}
              path={path}
              readOnly={readOnly}
              // A wiki-link followed in the split pane stays in the split
              // pane; in the primary it is the window's selection, as before.
              onNavigate={secondary
                ? (target) => {
                    // Keep the pane's declared mode, not the effective one —
                    // `readOnly` may only be on because this document is the
                    // one the primary pane already holds.
                    const s = useSplit.getState();
                    s.openSplit(target, s.reference);
                  }
                : undefined}
            />
          ) : (
            <p className="mw-prose-loading">Loading…</p>
          )}
        </div>
        <footer className="mw-prose-foot">
          <FooterStats text={doc?.body ?? ""} />
        </footer>
      </div>
      {/* Backlinks belong to the desk, not to the page — and the desk is the
          primary pane: their rows navigate the window's selection. */}
      {!secondary && <Backlinks path={path} />}
    </article>
  );
}

function PopoutButton({ path }: { path: string }) {
  const popout = usePopout();
  return (
    <button
      className="mw-popout-btn"
      title="Pop out (⌃⌘O)"
      onClick={() => popout.popOut(path)}
    >↗</button>
  );
}

/**
 * A second view of THIS document beside it.
 *
 * Rendered in the primary pane only, so the document it opens is by definition
 * the one the primary already holds — which the split shows read-only (see
 * `SplitHost`'s `sameDoc`). That is not a consolation prize: a second look at
 * chapter one while you write chapter twelve is what this button is for. To
 * get two *editable* documents, open the other one from its row's ⋯ menu.
 */
function SplitButton({ path }: { path: string }) {
  const { openSplit, secondaryPath, closeSplit } = useSplit();
  const open = secondaryPath === path;
  return (
    <button
      className="mw-popout-btn"
      title={open ? "Close split" : "Second view of this document, beside it"}
      aria-pressed={open}
      onClick={() => (open ? closeSplit() : openSplit(path))}
    >⫲</button>
  );
}

function SaveBadge({ status }: { status: string }) {
  const label =
    status === "dirty" ? "edited"
    : status === "saving" ? "saving…"
    : status === "saved" ? "saved"
    : status === "error" ? "save failed"
    // Not a failure: the file changed underneath and the save was held back
    // on purpose, with every character still in the buffer.
    : status === "conflict" ? "changed on disk"
    : "clean";
  return <span className={`mw-save mw-save-${status}`}>{label}</span>;
}

/**
 * The editor pane with nothing in it — two different nothings.
 *
 * With no selection it is an invitation; with a selection it is a file this
 * app has no editor or viewer for. The second case used to promise that
 * "Phase 4 wires up the WYSIWYG note editor", which shipped in Phase 4 and
 * left the sentence behind as a lie about the app's own state. Markdown,
 * Fountain, images, PDFs, HTML and video all route above this; anything
 * reaching here is genuinely unhandled, and saying so is the honest answer.
 */
function EditorPlaceholder({ selectedPath }: { selectedPath: string | null }) {
  const ext = selectedPath?.includes(".")
    ? selectedPath.slice(selectedPath.lastIndexOf(".")).toLowerCase()
    : null;
  return (
    <div className="mw-editor-placeholder">
      {selectedPath ? (
        <EmptyState
          art="folder"
          headline="No editor for this kind of file"
          subline={<>Aquarius opens Markdown, Fountain, images, PDFs, HTML and
            video. {ext ? <><code>{ext}</code> files</> : "This file"} stays where
            it is, untouched.</>}
        />
      ) : (
        <EmptyState
          art="book"
          headline="Nothing open yet"
          subline="Pick a document from the sidebar. Chapters in Drafts open on the page canvas; everything else opens in the note editor."
        />
      )}
    </div>
  );
}
