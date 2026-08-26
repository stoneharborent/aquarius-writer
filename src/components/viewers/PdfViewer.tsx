import { useEffect, useMemo, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { DownloadIcon, FitIcon, PdfIcon, PrintIcon, ZoomInIcon, ZoomOutIcon } from "@/icons";
import { vault } from "@/lib/vault";
import "./Viewer.css";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

interface PdfViewerProps {
  workflowId: string;
  path: string;
}

interface OutlineEntry {
  title: string;
  dest: unknown;
  pageIndex: number; // 0-based; -1 if unresolvable
}

type PdfDoc = Awaited<ReturnType<typeof pdfjsLib.getDocument>["promise"]>;

export function PdfViewer({ workflowId, path }: PdfViewerProps) {
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [outline, setOutline] = useState<OutlineEntry[] | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(1.1);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDoc(null); setOutline(null); setPageNumber(1); setError(null);
    void (async () => {
      try {
        const bytes = await vault().readBinary(workflowId, path);
        // pdf.js's worker transfers ownership of the ArrayBuffer; slice to a
        // fresh copy so the cached source stays usable across remounts.
        const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
        if (cancelled) return;
        setDoc(pdf);
        const raw = await pdf.getOutline();
        if (!raw || raw.length === 0) {
          setOutline([]);
        } else {
          const resolved: OutlineEntry[] = [];
          for (const item of raw) {
            let pageIndex = -1;
            try {
              const dest = typeof item.dest === "string"
                ? await pdf.getDestination(item.dest)
                : item.dest;
              if (Array.isArray(dest) && dest[0]) {
                pageIndex = await pdf.getPageIndex(dest[0]);
              }
            } catch { /* fall through */ }
            resolved.push({ title: item.title, dest: item.dest, pageIndex });
          }
          if (!cancelled) setOutline(resolved);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [workflowId, path]);

  // Render the current page to the canvas.
  useEffect(() => {
    if (!doc || !canvasRef.current) return;
    let cancelled = false;
    let renderTask: ReturnType<typeof page.render> | null = null;
    let page: Awaited<ReturnType<PdfDoc["getPage"]>>;
    void (async () => {
      try {
        page = await doc.getPage(pageNumber);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: zoom });
        const canvas = canvasRef.current!;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        renderTask = page.render({ canvasContext: ctx, viewport, canvas });
        await renderTask.promise;
      } catch (e) {
        if (!cancelled) console.warn("pdf render:", e);
      }
    })();
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [doc, pageNumber, zoom]);

  const file = useMemo(() => path.split("/").pop() ?? path, [path]);
  const totalPages = doc?.numPages ?? 0;
  const hasOutline = outline !== null && outline.length > 0;

  return (
    <div className="viewer pdf-viewer">
      <header className="vw-bar">
        <PdfIcon size={13} color="var(--ink-soft)" />
        <span className="vw-crumb">{path}</span>
        <span className="pdf-nav">
          <button
            disabled={pageNumber <= 1}
            onClick={() => setPageNumber((n) => Math.max(1, n - 1))}
          >‹</button>
          <span>page {pageNumber} / {totalPages || "—"}</span>
          <button
            disabled={pageNumber >= totalPages}
            onClick={() => setPageNumber((n) => Math.min(totalPages, n + 1))}
          >›</button>
        </span>
        <span className="vw-spacer" />
        <button className="vw-btn" onClick={() => setZoom((z) => Math.max(0.4, z - 0.2))} aria-label="Zoom out">
          <ZoomOutIcon size={13} color="var(--ink-soft)" />
        </button>
        <button className="vw-btn" onClick={() => setZoom(1.1)} aria-label="Fit">
          <FitIcon size={13} color="var(--ink-soft)" />
        </button>
        <button className="vw-btn" onClick={() => setZoom((z) => Math.min(4, z + 0.2))} aria-label="Zoom in">
          <ZoomInIcon size={13} color="var(--ink-soft)" />
        </button>
        <span className="vw-divider" />
        <button className="vw-btn" aria-label="Print"><PrintIcon size={13} color="var(--ink-soft)" /></button>
        <button className="vw-btn" aria-label="Download"><DownloadIcon size={13} color="var(--ink-soft)" /></button>
      </header>

      <div className={`pdf-body${hasOutline ? "" : " no-outline"}`}>
        {hasOutline && (
          <nav className="pdf-outline" aria-label="Outline">
            <div className="pdf-outline-head">Outline</div>
            {outline!.map((entry, i) => (
              <button
                key={i}
                className={`pdf-outline-item${entry.pageIndex + 1 === pageNumber ? " active" : ""}`}
                disabled={entry.pageIndex < 0}
                onClick={() => entry.pageIndex >= 0 && setPageNumber(entry.pageIndex + 1)}
              >
                {entry.title}
              </button>
            ))}
          </nav>
        )}

        <div className="pdf-canvas">
          {error ? (
            <div className="vw-empty">Couldn't open PDF. {error}</div>
          ) : (
            <canvas ref={canvasRef} className="pdf-page" />
          )}
        </div>

        <aside className="vw-inspector">
          <div className="vw-insp-head">Inspector</div>
          <dl className="vw-insp-grid">
            <dt>file</dt><dd className="vw-mono">{file}</dd>
            <dt>kind</dt><dd>PDF</dd>
            <dt>pages</dt><dd className="vw-mono">{totalPages || "—"}</dd>
            <dt>outline</dt><dd className="vw-mono">{outline === null ? "—" : `${outline.length} entries`}</dd>
            <dt>zoom</dt><dd className="vw-mono">{(zoom * 100).toFixed(0)}%</dd>
          </dl>
          <p className="vw-readonly">
            Viewers are read-only. To annotate, create a sibling{" "}
            <code>.md</code> note and <code>[[{file.replace(/\.[^.]+$/, "")}]]</code>.
          </p>
        </aside>
      </div>

      <footer className="vw-foot">
        <span>{file}</span>
        <span className="vw-spacer" />
        <span className="vw-mono">page {pageNumber} / {totalPages || "—"}</span>
        <span className="vw-mono">{(zoom * 100).toFixed(0)}%</span>
      </footer>
    </div>
  );
}
