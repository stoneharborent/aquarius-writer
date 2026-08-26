// Video viewer — web mirror of VideoViewer.swift (native playback controls).
import { useEffect, useState } from "react";
import { vault } from "@/lib/vault";
import "./Viewer.css";

export function VideoViewer({ workflowId, path }: { workflowId: string; path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setUrl(null); setError(null);
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

  return (
    <div className="viewer video-viewer">
      <header className="vw-bar">
        <span className="vw-crumb">{path}</span>
      </header>
      <div className="vw-body vw-center">
        {error && <p className="vw-empty">{error}</p>}
        {url && (
          <video src={url} controls style={{ maxWidth: "100%", maxHeight: "100%" }} />
        )}
      </div>
      <footer className="vw-foot">
        <span>Viewers are read-only.</span>
      </footer>
    </div>
  );
}
