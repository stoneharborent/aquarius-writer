// Version diff — web mirror of VersionDiffSheet.swift. Line diff between a
// stored version and the current text: common prefix/suffix trim + LCS.
import { useMemo } from "react";
import { Overlay } from "./Overlay";
import { useOverlay } from "@/state/overlayStore";
import { useVault } from "@/state/vaultStore";
import { useEditor } from "@/state/editorStore";
import { listVersions } from "@/lib/vault/aux";
import { stringify } from "@/lib/frontmatter";
import "./FindReplace.css";

type DiffLine = { k: "eq" | "add" | "del"; t: string };

function diffLines(oldT: string, newT: string): DiffLine[] {
  const a = oldT.split("\n"), b = newT.split("\n");
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s
         && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const am = a.slice(s, a.length - e), bm = b.slice(s, b.length - e);
  const out: DiffLine[] = [];
  for (let i = 0; i < s; i++) out.push({ k: "eq", t: a[i] });
  if (am.length && bm.length && am.length * bm.length > 2_250_000) {
    am.forEach((t) => out.push({ k: "del", t }));
    bm.forEach((t) => out.push({ k: "add", t }));
  } else {
    const n = am.length, m = bm.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) { out.push({ k: "eq", t: am[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ k: "del", t: am[i++] }); }
      else { out.push({ k: "add", t: bm[j++] }); }
    }
    while (i < n) out.push({ k: "del", t: am[i++] });
    while (j < m) out.push({ k: "add", t: bm[j++] });
  }
  for (let i = a.length - e; i < a.length; i++) out.push({ k: "eq", t: a[i] });
  return out;
}

const CONTEXT = 2;

export function VersionDiff() {
  const { payload } = useOverlay();
  const { current } = useVault();
  const { docs } = useEditor();
  const path = payload.path;
  const version = useMemo(() => {
    if (!current || !path || !payload.versionId) return null;
    return listVersions(current.id, path).find((v) => v.id === payload.versionId) ?? null;
  }, [current, path, payload.versionId]);

  const lines = useMemo(() => {
    if (!version || !path) return [];
    // Versions hold the full serialized doc — compare like with like.
    const doc = docs[path];
    const cur = doc ? stringify(doc.frontmatter, doc.body) : "";
    return diffLines(version.body, cur);
  }, [version, path, docs]);

  const keep = useMemo(() => {
    const k = new Array(lines.length).fill(false);
    lines.forEach((l, i) => {
      if (l.k !== "eq") {
        for (let j = Math.max(0, i - CONTEXT); j <= Math.min(lines.length - 1, i + CONTEXT); j++) k[j] = true;
      }
    });
    return k;
  }, [lines]);

  const hasDiff = lines.some((l) => l.k !== "eq");

  let skipping = false;
  return (
    <Overlay title={`Diff — ${version?.label ?? "version"} → current`} width={760}>
      <div className="vd">
        {!version && <p className="fr-idle">Version not found.</p>}
        {version && !hasDiff && <p className="fr-idle">No differences.</p>}
        {version && hasDiff && (
          <pre className="vd-pre">
            {lines.map((l, i) => {
              if (!keep[i]) {
                if (skipping) return null;
                skipping = true;
                return <span key={i} className="vd-skip">···</span>;
              }
              skipping = false;
              return (
                <span key={i} className={`vd-line vd-${l.k}`}>{l.t || " "}</span>
              );
            })}
          </pre>
        )}
      </div>
    </Overlay>
  );
}
