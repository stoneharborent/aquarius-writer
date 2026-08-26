import { useEffect, useMemo, useState } from "react";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { ChapterRail } from "@/components/rails/ChapterRail";
import { ScenesRail } from "@/components/rails/ScenesRail";
import { ProseEditor } from "@/components/editors/prose/ProseEditor";
import { NoteEditor } from "@/components/editors/note/NoteEditor";
import { ScreenplayEditor } from "@/components/editors/screenplay/ScreenplayEditor";
import { TitlePage } from "@/components/editors/screenplay/TitlePage";
import { EditorToolbar } from "@/components/editors/EditorToolbar";
import { estimatePages, type FountainElement } from "@/lib/markdown/fountain-smart";
import { ImageViewer } from "@/components/viewers/ImageViewer";
import { PdfViewer } from "@/components/viewers/PdfViewer";
import { HtmlViewer } from "@/components/viewers/HtmlViewer";
import { VideoViewer } from "@/components/viewers/VideoViewer";
import { useSplit } from "@/state/splitStore";
import { GhostSlot } from "@/components/popout/GhostSlot";
import { usePopout } from "@/state/popoutStore";
import { useLicense } from "@/state/licenseStore";
import { Backlinks } from "@/components/notes/Backlinks";
import { ManuscriptView } from "@/components/manuscript/ManuscriptView";
import { RightPane } from "@/components/rightpane/RightPane";
import { BookIcon } from "@/icons";
import { useVault } from "@/state/vaultStore";
import { useEditor } from "@/state/editorStore";
import { useOverlay } from "@/state/overlayStore";
import { collectScenes, splitTitlePage } from "@/lib/fountain";
import type { ChapterStatus } from "@/types/vault";
import "./MainWindow.css";

export function MainWindow() {
  const { selectedPath, view } = useVault();
  const isPopped = usePopout((s) => (selectedPath ? s.popped.has(selectedPath) : false));
  const split = useSplit();

  return (
    <div className="main-window">
      <Sidebar />

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

      <RightPane />
    </div>
  );
}

/** One document rendered by kind — shared by the primary and split panes. */
function DocView({ path, secondary = false }: { path: string | null; secondary?: boolean }) {
  const { current, selectPath, setView, reorderChapters, activeDraftId } = useVault();
  const license = useLicense();
  const draft = current?.drafts.find((d) => d.id === activeDraftId) ?? current?.drafts[0];
  const chapters = draft?.chapterOrder ?? current?.manuscripts[0]?.chapterOrder ?? [];
  const isChapter = path ? chapters.includes(path) : false;

  if (!path || !current) return <EditorPlaceholder selectedPath={path} />;

  if (isChapter) {
    return (
      <div className="mw-editor-split">
        {license.base === "studio" && !secondary && (
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
              <button className="mw-mode-btn"
                onClick={() => license.requestStudioFeature("manuscript") && setView("outline")}>
                Outline {license.base !== "studio" && <span className="mw-lock">✦</span>}
              </button>
              <button className="mw-mode-btn"
                onClick={() => license.requestStudioFeature("corkboard") && setView("corkboard")}>
                Cards {license.base !== "studio" && <span className="mw-lock">✦</span>}
              </button>
            </div>
          )}
          <ProsePane key={path} workflowId={current.id} path={path} />
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
    return license.base === "studio"
      ? <ScreenplayPane key={path} workflowId={current.id} path={path} />
      : <GatedPlaceholder onUnlock={() => license.requestStudioFeature("fountain")}
          kind="fountain" path={path} />;
  }
  if (path.endsWith(".md")) {
    return <NotePane key={path} workflowId={current.id} path={path} />;
  }
  return <EditorPlaceholder selectedPath={path} />;
}

function ProsePane({ workflowId, path }: { workflowId: string; path: string }) {
  const { docs, open, edit } = useEditor();
  const doc = docs[path];

  useEffect(() => {
    void open(workflowId, path);
  }, [workflowId, path, open]);

  const status = doc?.status ?? "clean";
  const fmStatus = doc?.frontmatter?.status as ChapterStatus | undefined;

  return (
    <article className="mw-prose">
      <header className="mw-prose-head">
        <span className="mw-prose-crumb">{path}</span>
        {fmStatus && (
          <span className={`mw-status mw-status-${fmStatus}`}>{fmStatus}</span>
        )}
        <SaveBadge status={status} />
        <SplitButton path={path} />
        <PopoutButton path={path} />
      </header>
      <EditorToolbar kind="md" path={path} />
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

function ScreenplayPane({ workflowId, path }: { workflowId: string; path: string }) {
  const { docs, open, edit } = useEditor();
  const doc = docs[path];

  useEffect(() => {
    void open(workflowId, path);
  }, [workflowId, path, open]);

  const parsed = useMemo(() => {
    if (!doc?.body) return { titlePage: {}, body: "", titleBlockText: "", scenes: [] };
    const split = splitTitlePage(doc.body);
    const titleBlockText = doc.body.slice(0, doc.body.length - split.body.length);
    return { ...split, titleBlockText, scenes: collectScenes(split.body) };
  }, [doc?.body]);

  const [activeScene, setActiveScene] = useState<number | null>(0);
  const [caretElement, setCaretElement] = useState<FountainElement | null>(null);
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
        <EditorToolbar kind="fountain" path={path} activeElement={caretElement} />
        {Object.keys(parsed.titlePage).length > 0 && <TitlePage tp={parsed.titlePage} />}
        <div className="mw-prose-editor">
          {doc ? (
            <ScreenplayEditor
              value={parsed.body}
              onChange={handleBodyEdit}
              path={path}
              onElement={setCaretElement}
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

function NotePane({ workflowId, path }: { workflowId: string; path: string }) {
  const { docs, open, edit } = useEditor();
  const doc = docs[path];

  useEffect(() => {
    void open(workflowId, path);
  }, [workflowId, path, open]);

  const status = doc?.status ?? "clean";
  const title = (doc?.frontmatter?.title as string | undefined)
    ?? path.split("/").pop()?.replace(/\.md$/, "")
    ?? path;

  return (
    <article className="mw-prose mw-note">
      <header className="mw-prose-head">
        <span className="mw-prose-crumb">{path}</span>
        <SaveBadge status={status} />
        <SplitButton path={path} />
        <PopoutButton path={path} />
      </header>
      <EditorToolbar kind="md" path={path} />
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

function GatedPlaceholder({
  path, onUnlock,
}: { kind: "fountain"; path: string; onUnlock: () => boolean }) {
  return (
    <div className="mw-editor-placeholder">
      <ScreenplayIconStub />
      <h1 className="mw-editor-title">Screenplay editor is a Studio feature</h1>
      <p className="mw-editor-sub">
        <span className="mw-mono-path">{path}</span> is a Fountain screenplay.
        Studio unlocks the editor, scenes rail, title page, and FDX export.
      </p>
      <button className="ul-primary" onClick={onUnlock}>Unlock Studio · $50 once</button>
    </div>
  );
}

function ScreenplayIconStub() {
  return (
    <svg width="28" height="28" viewBox="0 0 16 16" fill="none" stroke="var(--ink-mute)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.2" />
      <path d="M5 6h6M5 8.5h6M5 11h4" />
    </svg>
  );
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
