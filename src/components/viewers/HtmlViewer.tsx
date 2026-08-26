// Read-only HTML viewer — web mirror of HtmlViewer.swift (sandboxed iframe).
import { useEffect, useState } from "react";
import { vault } from "@/lib/vault";
import "./Viewer.css";

export function HtmlViewer({ workflowId, path }: { workflowId: string; path: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    void (async () => {
      try {
        const body = await vault().readFile(workflowId, path);
        url = URL.createObjectURL(new Blob([body], { type: "text/html" }));
        if (!cancelled) setSrc(url);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [workflowId, path]);

  return (
    <div className="viewer html-viewer">
      <header className="vw-bar">
        <span className="vw-crumb">{path}</span>
      </header>
      <div className="vw-body">
        {error && <p className="vw-empty">{error}</p>}
        {src && (
          <iframe
            title={path}
            src={src}
            sandbox=""
            style={{ width: "100%", height: "100%", border: 0, background: "#fff" }}
          />
        )}
      </div>
      <footer className="vw-foot">
        <span>Viewers are read-only.</span>
      </footer>
    </div>
  );
}
