import { useEffect, useMemo, useRef, useState } from "react";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { ChapterRail } from "@/components/rails/ChapterRail";
import { ScenesRail } from "@/components/rails/ScenesRail";
import { ProseEditor } from "@/components/editors/prose/ProseEditor";
import { NoteEditor } from "@/components/editors/note/NoteEditor";
import { ScreenplayEditor } from "@/components/editors/screenplay/ScreenplayEditor";
import { TitlePage } from "@/components/editors/screenplay/TitlePage";
import { estimatePages } from "@/lib/markdown/fountain-smart";
import { ImageViewer } from "@/components/viewers/ImageViewer";
import { PdfViewer } from "@/components/viewers/PdfViewer";
import { HtmlViewer } from "@/components/viewers/HtmlViewer";
import { VideoViewer } from "@/components/viewers/VideoViewer";
import { useSplit } from "@/state/splitStore";
import { GhostSlot } from "@/components/popout/GhostSlot";
import { usePopout } from "@/state/popoutStore";
import { Backlinks } from "@/components/notes/Backlinks";
import { ManuscriptView } from "@/components/manuscript/ManuscriptView";
import { RightPane } from "@/components/rightpane/RightPane";
import { TopBar } from "@/components/shell/TopBar";
import { Gutter } from "@/components/shell/Gutter";
import { Splitter } from "@/components/shell/Splitter";
import { BookIcon } from "@/icons";
import { useVault } from "@/state/vaultStore";
import { useEditor } from "@/state/editorStore";
import { useOverlay } from "@/state/overlayStore";
import { useToolbar } from "@/state/toolbarStore";
import {
  EDITOR_MIN, GUTTER,
  RIGHT_DEFAULT, RIGHT_MIN,
  SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
  useShell,
} from "@/state/shellStore";
import { collectScenes, splitTitlePage } from "@/lib/fountain";
import type { ChapterStatus } from "@/types/vault";
import "./MainWindow.css";

export function MainWindow() {
  const { selectedPath, view } = useVault();
  const isPopped = usePopout((s) => (selectedPath ? s.popped.has(selectedPath) : false));
  const split = useSplit();
  const {
    sidebarWidth, sidebarCollapsed, setSidebarWidth, setSidebarCollapsed,
    rightWidth, rightCollapsed, setRightWidth, setRightCollapsed,
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
          {view !== "editor" ? (
            <ManuscriptView />
          ) : (
            <div className="mw-split-host">
              <section className="mw-pane">
                {selectedPath && isPopped
                  ? <GhostSlot path={selectedPath} />
                  : <DocView path={selectedPath} />}
              </section>
              {split.secondaryPath && (
                <section className="mw-pane mw-pane-secondary">
                  <header className="mw-pane-head">
                    <span className="mw-pane-crumb">{split.secondaryPath}</span>
                    <button
                      className={`mw-mode-btn${split.reference ? " on" : ""}`}
                      title="Reference mode — read-only"
                      onClick={() => split.setReference(!split.reference)}
                    >Reference</button>
                    <button className="mw-mode-btn" title="Close split"
                      onClick={split.closeSplit}>✕</button>
                  </header>
                  <div className={split.reference ? "mw-pane-body mw-readonly" : "mw-pane-body"}>
                    <DocView path={split.secondaryPath} secondary />
                  </div>
                </section>
              )}
            </div>
          )}
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

        {rightCollapsed
          ? <Gutter label="Comments" side="left" onOpen={() => setRightCollapsed(false)} />
          : <RightPane />}
      </div>
    </div>
  );
}

/** One document rendered by kind — shared by the primary and split panes. */
function DocView({ path, secondary = false }: { path: string | null; secondary?: boolean }) {
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
          <ProsePane key={path} workflowId={current.id} path={path} secondary={secondary} />
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
    return <ScreenplayPane key={path} workflowId={current.id} path={path} secondary={secondary} />;
  }
  if (path.endsWith(".md")) {
    return <NotePane key={path} workflowId={current.id} path={path} secondary={secondary} />;
  }
  return <EditorPlaceholder selectedPath={path} />;
}

/**
 * Tell the top bar which document its toolbar is driving.
 *
 * Only the primary pane speaks: there is one toolbar row for the window, and a
 * split pane claiming it would swap the toolbar under the writer's hands every
 * time the split opened.
 */
function useToolbarContext(kind: "md" | "fountain", path: string, secondary: boolean) {
  useEffect(() => {
    if (secondary) return;
    useToolbar.getState().setContext(kind, path);
    return () => useToolbar.getState().clear(path);
  }, [kind, path, secondary]);
}

function ProsePane({ workflowId, path, secondary = false }: {
  workflowId: string; path: string; secondary?: boolean;
}) {
  const { docs, open, edit } = useEditor();
  const doc = docs[path];

  useEffect(() => {
    void open(workflowId, path);
  }, [workflowId, path, open]);

  useToolbarContext("md", path, secondary);

  const status = doc?.status ?? "clean";
  const fmStatus = doc?.frontmatter?.status as ChapterStatus | undefined;

  return (
    <article className="mw-prose mw-canvas">
      <header className="mw-prose-head">
        <span className="mw-prose-crumb">{path}</span>
        {fmStatus && (
          <span className={`mw-status mw-status-${fmStatus}`}>{fmStatus}</span>
        )}
        <SaveBadge status={status} />
        <SplitButton path={path} />
        <PopoutButton path={path} />
      </header>
      <div className="mw-sheet">
        <h1 className="mw-prose-title">
          {(doc?.frontmatter?.title as string | undefined) ?? path}
        </h1>
        <div className="mw-prose-editor">
          {doc ? (
            <ProseEditor value={doc.body} onChange={(v) => edit(path, v)} path={path} />
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

/** Words · characters · read time — parity with EditorFooterStats.swift. */
function FooterStats({ text, extra }: { text: string; extra?: React.ReactNode }) {
  const words = useMemo(() => countWords(text), [text]);
  const chars = text.length;
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

function ScreenplayPane({ workflowId, path, secondary = false }: {
  workflowId: string; path: string; secondary?: boolean;
}) {
  const { docs, open, edit } = useEditor();
  const doc = docs[path];

  useEffect(() => {
    void open(workflowId, path);
  }, [workflowId, path, open]);

  useToolbarContext("fountain", path, secondary);

  const parsed = useMemo(() => {
    if (!doc?.body) return { titlePage: {}, body: "", titleBlockText: "", scenes: [] };
    const split = splitTitlePage(doc.body);
    const titleBlockText = doc.body.slice(0, doc.body.length - split.body.length);
    return { ...split, titleBlockText, scenes: collectScenes(split.body) };
  }, [doc?.body]);

  const [activeScene, setActiveScene] = useState<number | null>(0);
  const [pageCount, setPageCount] = useState<number | null>(null);

  useEffect(() => {
    if (parsed.body) setPageCount(estimatePages(parsed.body.split("\n")).pageCount);
  }, [parsed.body]);

  function handleSceneSelect(idx: number) {
    setActiveScene(idx);
    const scene = parsed.scenes[idx];
    if (!scene) return;
    const host = document.querySelector<HTMLDivElement>(".screenplay-editor");
    const fn = (host as HTMLDivElement & { __screenplayScroll?: (n: number) => void } | null)?.__screenplayScroll;
    fn?.(scene.from);
  }

  function handleBodyEdit(nextBody: string) {
    // Reassemble title block + edited body before pushing to the editor store.
    edit(path, parsed.titleBlockText + nextBody);
  }

  const wordCount = useMemo(
    () => (parsed.body ? countWords(parsed.body) : 0),
    [parsed.body],
  );
  const status = doc?.status ?? "clean";

  return (
    <div className="mw-editor-split">
      <ScenesRail
        scenes={parsed.scenes}
        activeIndex={activeScene}
        onSelect={handleSceneSelect}
      />
      {/* The screenplay keeps its own surface — its paged canvas with real page
          breaks is a later wave (PARITY row 12), and dropping it onto the prose
          page sheet now would fake a page geometry it does not have yet. */}
      <article className="mw-prose mw-screenplay">
        <header className="mw-prose-head">
          <span className="mw-prose-crumb">{path}</span>
          <button className="mw-mode-btn" title="Print-layout preview"
            onClick={() => useOverlay.getState().open("screenplay-preview", { path })}>
            Preview
          </button>
          <SaveBadge status={status} />
          <SplitButton path={path} />
        </header>
        {Object.keys(parsed.titlePage).length > 0 && <TitlePage tp={parsed.titlePage} />}
        <div className="mw-prose-editor">
          {doc ? (
            <ScreenplayEditor
              value={parsed.body}
              onChange={handleBodyEdit}
              path={path}
              onElement={(el) => { if (!secondary) useToolbar.getState().setElement(el); }}
              onPageCount={setPageCount}
            />
          ) : (
            <p className="mw-prose-loading">Loading…</p>
          )}
        </div>
        <footer className="mw-prose-foot">
          <span>{parsed.scenes.length} scenes</span>
          {pageCount !== null && <span>{pageCount} {pageCount === 1 ? "page" : "pages"}</span>}
          <span>{wordCount.toLocaleString()} words</span>
        </footer>
      </article>
    </div>
  );
}

function NotePane({ workflowId, path, secondary = false }: {
  workflowId: string; path: string; secondary?: boolean;
}) {
  const { docs, open, edit } = useEditor();
  const doc = docs[path];

  useEffect(() => {
    void open(workflowId, path);
  }, [workflowId, path, open]);

  useToolbarContext("md", path, secondary);

  const status = doc?.status ?? "clean";
  const title = (doc?.frontmatter?.title as string | undefined)
    ?? path.split("/").pop()?.replace(/\.md$/, "")
    ?? path;

  return (
    <article className="mw-prose mw-note mw-canvas">
      <header className="mw-prose-head">
        <span className="mw-prose-crumb">{path}</span>
        <SaveBadge status={status} />
        <SplitButton path={path} />
        <PopoutButton path={path} />
      </header>
      <div className="mw-sheet">
        <h1 className="mw-prose-title">{title}</h1>
        <div className="mw-prose-editor">
          {doc ? (
            <NoteEditor value={doc.body} onChange={(v) => edit(path, v)} path={path} />
          ) : (
            <p className="mw-prose-loading">Loading…</p>
          )}
        </div>
        <footer className="mw-prose-foot">
          <FooterStats text={doc?.body ?? ""} />
        </footer>
      </div>
      {/* Backlinks belong to the desk, not to the page. */}
      <Backlinks path={path} />
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

/** Open this document in the secondary split pane. */
function SplitButton({ path }: { path: string }) {
  const { openSplit, secondaryPath, closeSplit } = useSplit();
  const open = secondaryPath === path;
  return (
    <button
      className="mw-popout-btn"
      title={open ? "Close split" : "Open in split pane"}
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
    : "clean";
  return <span className={`mw-save mw-save-${status}`}>{label}</span>;
}

function EditorPlaceholder({ selectedPath }: { selectedPath: string | null }) {
  return (
    <div className="mw-editor-placeholder">
      <BookIcon size={28} color="var(--ink-mute)" />
      <h1 className="mw-editor-title">
        {selectedPath ? "Open this in the right editor" : "Pick a chapter from the sidebar"}
      </h1>
      <p className="mw-editor-sub">
        {selectedPath
          ? "Phase 4 wires up the WYSIWYG note editor for non-chapter markdown."
          : "Drafts/ holds the prose editor; everything else opens in the note editor."}
      </p>
    </div>
  );
}

function countWords(s: string): number {
  return (s.trim().match(/\S+/g) ?? []).length;
}
