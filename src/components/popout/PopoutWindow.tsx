import { useEffect } from "react";
import { useVault } from "@/state/vaultStore";
import { useEditor } from "@/state/editorStore";
import { ProseEditor } from "@/components/editors/prose/ProseEditor";
import { NoteEditor } from "@/components/editors/note/NoteEditor";
import { ScreenplayEditor } from "@/components/editors/screenplay/ScreenplayEditor";
import { TitlePage } from "@/components/editors/screenplay/TitlePage";
import { ImageViewer } from "@/components/viewers/ImageViewer";
import { PdfViewer } from "@/components/viewers/PdfViewer";
import { splitTitlePage } from "@/lib/fountain";
import "./PopoutWindow.css";

interface PopoutWindowProps {
  path: string;
}

export function PopoutWindow({ path }: PopoutWindowProps) {
  const { current, bootstrap } = useVault();
  // One document per popout window — select it, rather than waking this whole
  // window's tree on every keystroke in every buffer the store holds.
  const doc = useEditor((s) => s.docs[path]);
  const open = useEditor((s) => s.open);
  const edit = useEditor((s) => s.edit);

  // A popout window boots with an empty store, so it has to find the workflow
  // for itself. `bootstrap` is the same path the main window takes: the last
  // workflow, else the index. It used to ask for "lantern" by name, which only
  // exists in the browser mock — in the real shell that failed silently and the
  // popout stayed empty forever.
  useEffect(() => {
    if (!current) void bootstrap();
  }, [current, bootstrap]);

  useEffect(() => {
    if (current) void open(current.id, path);
  }, [current, path, open]);

  return (
    <div className="popout">
      <header className="popout-bar" data-tauri-drag-region>
        <span className="popout-title">{path}</span>
        <button
          className="popout-reattach"
          onClick={() => window.close()}
          title="Reattach to host (⌃⌘O)"
        >reattach</button>
      </header>

      <main className="popout-body">
        {!doc ? (
          <div className="popout-loading">Loading…</div>
        ) : path.endsWith(".fountain") ? (
          <FountainPopout path={path} body={doc.body} onChange={(v) => edit(path, v)} />
        ) : path.endsWith(".md") ? (
          /^Drafts\//.test(path)
            ? <ProseEditor value={doc.body} onChange={(v) => edit(path, v)} />
            : <NoteEditor value={doc.body} onChange={(v) => edit(path, v)} />
        ) : /\.(jpe?g|png|gif|webp|svg|bmp)$/i.test(path) && current ? (
          <ImageViewer workflowId={current.id} path={path} />
        ) : /\.pdf$/i.test(path) && current ? (
          <PdfViewer workflowId={current.id} path={path} />
        ) : (
          <div className="popout-loading">Unsupported file type.</div>
        )}
      </main>
    </div>
  );
}

function FountainPopout({ body, onChange }: { path: string; body: string; onChange: (v: string) => void }) {
  const split = splitTitlePage(body);
  const titleBlockText = body.slice(0, body.length - split.body.length);
  return (
    <>
      {Object.keys(split.titlePage).length > 0 && <TitlePage tp={split.titlePage} />}
      <ScreenplayEditor
        value={split.body}
        onChange={(v) => onChange(titleBlockText + v)}
      />
    </>
  );
}
