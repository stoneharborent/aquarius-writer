import { useEffect, useMemo, useRef, useState } from "react";
import { Overlay } from "./Overlay";
import { useVault } from "@/state/vaultStore";
import { useOverlay } from "@/state/overlayStore";
import { collectMarkdown, extractLinks } from "@/lib/wikilinks";
import { vault } from "@/lib/vault";
import { parse } from "@/lib/frontmatter";
import "./Graph.css";

interface Node {
  id: string;
  label: string;
  kind: "chapter" | "character" | "world" | "other";
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface Edge {
  from: string;
  to: string;
}

const KIND_COLOR: Record<Node["kind"], string> = {
  chapter: "var(--accent)",
  character: "var(--starred)",
  world: "var(--success)",
  other: "var(--ink-soft)",
};

function classify(path: string): Node["kind"] {
  if (/^Drafts\//.test(path)) return "chapter";
  if (/^Characters\//.test(path)) return "character";
  if (/^Worldbuilding\//.test(path)) return "world";
  return "other";
}

export function Graph() {
  const { tree, current, selectPath, setView } = useVault();
  const closeOv = useOverlay((s) => s.close);
  const [graph, setGraph] = useState<{ nodes: Node[]; edges: Edge[] } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const W = 720;
  const H = 480;

  // Load bodies, extract links, build graph
  useEffect(() => {
    if (!tree || !current) return;
    let cancelled = false;
    void (async () => {
      const files = collectMarkdown(tree);
      const bodies: Record<string, string> = {};
      for (const f of files) {
        try {
          const raw = await vault().readFile(current.id, f.path);
          bodies[f.path] = parse(raw).body;
        } catch { bodies[f.path] = ""; }
      }
      if (cancelled) return;

      const nodes: Node[] = files.map((f, i) => {
        const angle = (i / files.length) * Math.PI * 2;
        return {
          id: f.path,
          label: f.name,
          kind: classify(f.path),
          x: W / 2 + Math.cos(angle) * 160,
          y: H / 2 + Math.sin(angle) * 160,
          vx: 0,
          vy: 0,
        };
      });

      const edges: Edge[] = [];
      for (const f of files) {
        const links = extractLinks(bodies[f.path] ?? "", files);
        for (const l of links) {
          if (l.path && l.path !== f.path) {
            edges.push({ from: f.path, to: l.path });
          }
        }
      }
      setGraph({ nodes, edges });
    })();
    return () => { cancelled = true; };
  }, [tree, current]);

  // Force simulation
  useEffect(() => {
    if (!graph) return;
    // Bind the non-null graph to a local so the narrowing survives into `step`,
    // which TypeScript can't prove is only called while `graph` is set.
    const g = graph;
    let raf = 0;
    const idIdx = new Map(g.nodes.map((n, i) => [n.id, i]));

    function step() {
      const { nodes, edges } = g;

      // Repulsion
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist2 = Math.max(20, dx * dx + dy * dy);
          const f = 1200 / dist2;
          const dist = Math.sqrt(dist2);
          const fx = (dx / dist) * f;
          const fy = (dy / dist) * f;
          a.vx -= fx; a.vy -= fy;
          b.vx += fx; b.vy += fy;
        }
      }

      // Attraction along edges
      for (const e of edges) {
        const a = nodes[idIdx.get(e.from)!];
        const b = nodes[idIdx.get(e.to)!];
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const target = 110;
        const f = (dist - target) * 0.02;
        const fx = (dx / dist) * f;
        const fy = (dy / dist) * f;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }

      // Center pull + integrate
      for (const n of nodes) {
        n.vx += (W / 2 - n.x) * 0.005;
        n.vy += (H / 2 - n.y) * 0.005;
        n.vx *= 0.82; n.vy *= 0.82;
        n.x += n.vx; n.y += n.vy;
        n.x = Math.max(24, Math.min(W - 24, n.x));
        n.y = Math.max(24, Math.min(H - 24, n.y));
      }
      setGraph({ ...g });
      raf = requestAnimationFrame(step);
    }
    raf = requestAnimationFrame(step);
    // Stop after ~3s
    const stop = setTimeout(() => cancelAnimationFrame(raf), 3000);
    return () => { cancelAnimationFrame(raf); clearTimeout(stop); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph?.nodes.length]);

  const lookup = useMemo(() => {
    const m = new Map<string, Node>();
    graph?.nodes.forEach((n) => m.set(n.id, n));
    return m;
  }, [graph]);

  function handleOpen(path: string) {
    selectPath(path);
    setView("editor");
    closeOv();
  }

  return (
    <Overlay title="Graph" width={760}>
      <div className="gv">
        <div className="gv-legend">
          <span><i style={{ background: KIND_COLOR.chapter }} /> Chapters</span>
          <span><i style={{ background: KIND_COLOR.character }} /> Characters</span>
          <span><i style={{ background: KIND_COLOR.world }} /> Worldbuilding</span>
          <span className="gv-meta">{graph?.nodes.length ?? 0} nodes · {graph?.edges.length ?? 0} links</span>
        </div>
        <svg ref={svgRef} className="gv-svg" viewBox={`0 0 ${W} ${H}`} width="100%" height={H}>
          {graph?.edges.map((e, i) => {
            const a = lookup.get(e.from);
            const b = lookup.get(e.to);
            if (!a || !b) return null;
            return (
              <line
                key={i}
                x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke="var(--line-strong)"
                strokeWidth={1}
              />
            );
          })}
          {graph?.nodes.map((n) => (
            <g key={n.id} transform={`translate(${n.x},${n.y})`} className="gv-node"
               onClick={() => handleOpen(n.id)}>
              <circle r={9} fill={KIND_COLOR[n.kind]} />
              <text x={12} y={4} fontFamily="var(--font-ui)" fontSize={11} fill="var(--ink)">
                {n.label}
              </text>
            </g>
          ))}
        </svg>
      </div>
    </Overlay>
  );
}
