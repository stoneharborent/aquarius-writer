/**
 * The frame meter — `AQ_PERF=1` (docs/NOTES.md §27k).
 *
 * WHY IT EXISTS. "Scrolling feels sluggish on Linux" is not a number, and
 * every fix in the §27k pass is a claim about paint cost that cannot be
 * checked from a Mac: Apple Silicon runs the same CSS through CoreAnimation
 * and will report a flat 120fps whatever we do. This draws a number on the
 * shipped AppImage, on the machine that feels slow, so a change can be shown
 * to have worked instead of asserted to have.
 *
 * WHAT IT MEASURES. A `requestAnimationFrame` loop, and nothing else — no
 * PerformanceObserver, no long-task API, nothing WebKitGTK might not have.
 *
 *   FPS      frames in the last second.
 *   ms       the SLOWEST frame in the last second. This is the number that
 *            matters for "sluggish": an average of 60 with one 90ms frame in
 *            it is what a stutter is, and the average hides it.
 *   jank     running count of frames that took longer than two frames' worth
 *            of time at the display's own rate — i.e. dropped frames — since
 *            the meter started. It only ever goes up, so scroll a document,
 *            watch what it climbs by, change something, scroll again.
 *
 * WHY rAF IS THE RIGHT PROBE HERE. A rAF callback runs immediately before the
 * frame's style/layout/paint, so a long gap between two callbacks means the
 * previous frame's work (including paint and compositing) overran. That is
 * exactly the quantity §27k is about.
 *
 * COST WHEN OFF. Nil. Nothing in this module is imported unless the meter is
 * enabled — `main.tsx` reaches it through a dynamic `import()`, so the whole
 * file is a separate chunk that a normal launch never fetches, parses or
 * evaluates.
 */

const REFRESH_MS = 500;

export interface PerfMeterHandle {
  stop: () => void;
}

/** Mount the chip and start sampling. Idempotent per document. */
export function startPerfMeter(): PerfMeterHandle {
  const existing = document.getElementById("aq-perf");
  if (existing) return { stop: () => existing.remove() };

  const el = document.createElement("div");
  el.id = "aq-perf";
  // Inline, because a stylesheet import would pull this chunk's CSS into the
  // main bundle and the "zero cost when disabled" promise with it.
  el.style.cssText = [
    "position:fixed",
    "right:10px",
    "bottom:10px",
    "z-index:2147483647",
    "pointer-events:none",
    "user-select:none",
    "display:flex",
    "gap:10px",
    "align-items:baseline",
    "padding:4px 8px",
    "border-radius:var(--radius-button, 6px)",
    "border:1px solid var(--line-strong)",
    "background:var(--surface-alt)",
    "color:var(--ink-soft)",
    "font-family:var(--font-mono)",
    "font-size:10px",
    "line-height:14px",
    "letter-spacing:0.02em",
    "white-space:nowrap",
    // No blur, no filter, no backdrop — a meter that costs a frame to draw is
    // measuring itself. This is the one place in the app where that would be
    // an actual correctness bug rather than a nicety.
    "box-shadow:none",
  ].join(";");

  const fpsEl = document.createElement("span");
  const worstEl = document.createElement("span");
  const jankEl = document.createElement("span");
  jankEl.style.color = "var(--warn)";
  el.append(fpsEl, worstEl, jankEl);
  document.body.appendChild(el);

  let frames = 0;
  let worst = 0;
  let jank = 0;
  let last = performance.now();
  let windowStart = last;
  // Learn the display's own frame budget from the fastest frame seen, so a
  // 144Hz handheld is not permanently reported as janking. Seeded at 60Hz.
  let budget = 1000 / 60;
  let raf = 0;
  let live = true;

  const tick = (now: number) => {
    if (!live) return;
    const dt = now - last;
    last = now;
    frames++;
    if (dt > worst) worst = dt;
    if (dt > 1 && dt < budget) budget = dt;
    // Two frames' worth of time = one frame dropped.
    if (dt > budget * 1.8) jank++;

    if (now - windowStart >= REFRESH_MS) {
      const fps = Math.round((frames * 1000) / (now - windowStart));
      fpsEl.textContent = `${fps} fps`;
      worstEl.textContent = `${worst.toFixed(0)}ms worst`;
      jankEl.textContent = `${jank} jank`;
      // Colour the chip by the worst frame, not the average — that is the one
      // a human perceives.
      el.style.color = worst > budget * 4 ? "var(--danger)"
        : worst > budget * 1.8 ? "var(--warn)"
        : "var(--ink-soft)";
      frames = 0;
      worst = 0;
      windowStart = now;
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return {
    stop() {
      live = false;
      cancelAnimationFrame(raf);
      el.remove();
    },
  };
}
