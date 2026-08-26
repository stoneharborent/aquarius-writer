import { useEffect, useMemo, useState } from "react";
import {
  DownloadIcon,
  FitIcon,
  ImageIcon,
  RotateIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "@/icons";
import { vault } from "@/lib/vault";
import "./Viewer.css";

interface ImageViewerProps {
  workflowId: string;
  path: string;
}

export function ImageViewer({ workflowId, path }: ImageViewerProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [rotate, setRotate] = useState(0);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setUrl(null); setError(null); setZoom(1); setRotate(0); setNatural(null);
    void (async () => {
      try {
        const u = await vault().resolveAssetUrl(workflowId, path);
        if (!cancelled) setUrl(u);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [workflowId, path]);

  const file = useMemo(() => path.split("/").pop() ?? path, [path]);

  return (
    <div className="viewer image-viewer">
      <header className="vw-bar">
        <ImageIcon size={13} color="var(--ink-soft)" />
        <span className="vw-crumb">{path}</span>
        <span className="vw-spacer" />
        <button className="vw-btn" onClick={() => setZoom((z) => Math.max(0.25, z - 0.2))} aria-label="Zoom out">
          <ZoomOutIcon size={13} color="var(--ink-soft)" />
        </button>
        <button className="vw-btn" onClick={() => { setZoom(1); setRotate(0); }} aria-label="Fit">
          <FitIcon size={13} color="var(--ink-soft)" />
        </button>
        <button className="vw-btn" onClick={() => setZoom((z) => Math.min(8, z + 0.2))} aria-label="Zoom in">
          <ZoomInIcon size={13} color="var(--ink-soft)" />
        </button>
        <span className="vw-divider" />
        <button className="vw-btn" onClick={() => setRotate((r) => (r + 90) % 360)} aria-label="Rotate">
          <RotateIcon size={13} color="var(--ink-soft)" />
        </button>
        <button className="vw-btn" aria-label="Download">
          <DownloadIcon size={13} color="var(--ink-soft)" />
        </button>
      </header>

      <div className="vw-body">
        <div className="vw-canvas">
          {error ? (
            <div className="vw-empty">Couldn't load image. {error}</div>
          ) : !url ? (
            <div className="vw-empty">Loading…</div>
          ) : (
            <img
              src={url}
              alt={file}
              draggable={false}
              style={{
                transform: `rotate(${rotate}deg) scale(${zoom})`,
                transition: "transform 120ms ease",
              }}
              onLoad={(e) => setNatural({
                w: e.currentTarget.naturalWidth,
                h: e.currentTarget.naturalHeight,
              })}
            />
          )}
        </div>

        <aside className="vw-inspector">
          <div className="vw-insp-head">Inspector</div>
          <dl className="vw-insp-grid">
            <dt>file</dt><dd className="vw-mono">{file}</dd>
            <dt>kind</dt><dd>Image</dd>
            <dt>natural</dt><dd className="vw-mono">{natural ? `${natural.w} × ${natural.h}` : "—"}</dd>
            <dt>zoom</dt><dd className="vw-mono">{(zoom * 100).toFixed(0)}%</dd>
            <dt>rotation</dt><dd className="vw-mono">{rotate}°</dd>
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
        <span className="vw-mono">{(zoom * 100).toFixed(0)}%</span>
        <span className="vw-mono">{rotate}°</span>
      </footer>
    </div>
  );
}
