// The app's one way of saying "there is nothing here yet".
//
// Swift's rule, from SWIFT-AUDIT §1.6: **empty states are never a shrug.**
// Every one of them is a hand-drawn line illustration, a serif headline, an
// italic subline and — where there is something to do about it — one button.
// The port had five different flavors of grey sentence instead, one of which
// still promised a "Phase 4" that shipped months ago.
//
// The illustrations are inline SVG rather than the glyph set in `@/icons`,
// because these are a different job: 56px drawings with open composition and
// a lighter stroke, not 16px UI marks scaled up. They take their color from
// `currentColor`, so a caller can tint the whole thing by setting `color` and
// the theme swap costs nothing.
import type { ReactNode } from "react";
import "./EmptyState.css";

export type EmptyArt = "folder" | "book" | "star" | "search";

interface EmptyStateProps {
  art: EmptyArt;
  /** One line, serif, sentence case, no trailing period. */
  headline: string;
  /** One or two lines, italic — what to do, or why it is empty. */
  subline?: ReactNode;
  /** The single action, when there is one worth offering. */
  action?: { label: string; onClick: () => void };
  /**
   * `inline` is the compact form for a sidebar or a sheet: smaller art, no
   * vertical centring, so it sits under a row rather than taking the pane.
   */
  size?: "page" | "inline";
  className?: string;
}

export function EmptyState({
  art, headline, subline, action, size = "page", className,
}: EmptyStateProps) {
  return (
    <div className={`empty empty-${size}${className ? ` ${className}` : ""}`}>
      <ZeroIllustration art={art} size={size === "page" ? 60 : 44} />
      <h2 className="empty-headline">{headline}</h2>
      {subline && <p className="empty-sub">{subline}</p>}
      {action && (
        <button className="empty-cta" onClick={action.onClick}>{action.label}</button>
      )}
    </div>
  );
}

/**
 * The drawings. One 64-unit box each, stroked in `currentColor`.
 *
 * They are deliberately unfinished-looking — open corners, a line that stops
 * short — because a tidy filled icon reads as a status badge, and the point of
 * this whole component is that an empty pane should look like a page waiting
 * to be written on.
 */
export function ZeroIllustration({ art, size = 56 }: { art: EmptyArt; size?: number }) {
  return (
    <svg
      className="empty-art"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ART[art]}
    </svg>
  );
}

const ART: Record<EmptyArt, ReactNode> = {
  // An open folder with two sheets rising out of it.
  folder: (
    <>
      <path d="M8 24v26a3 3 0 0 0 3 3h42a3 3 0 0 0 3-3V24" />
      <path d="M8 24v-6a3 3 0 0 1 3-3h13l4 5h21a3 3 0 0 1 3 3v1" />
      <path d="M22 24V12h14l4 4h6v8" opacity="0.45" />
      <path d="M28 34h8M28 40h13" opacity="0.55" />
    </>
  ),

  // A book lying open, with a ribbon.
  book: (
    <>
      <path d="M32 20v30" />
      <path d="M32 20c-4-4-11-6-19-6v30c8 0 15 2 19 6" />
      <path d="M32 20c4-4 11-6 19-6v30c-8 0-15 2-19 6" />
      <path d="M14 44H9a2 2 0 0 0-2 2v4M50 44h5a2 2 0 0 1 2 2v4" opacity="0.4" />
      <path d="M40 14v13l3-3 3 3V14" opacity="0.5" />
    </>
  ),

  // A five-pointed star, drawn once, with two small sparks beside it.
  star: (
    <>
      <path d="M30 12l5.6 11.9 12.4 1.8-9 9.1 2.1 12.9L30 41.6l-11.1 6.1 2.1-12.9-9-9.1 12.4-1.8L30 12z" />
      <path d="M50 15v6M47 18h6" opacity="0.45" />
      <path d="M45 48v4M43 50h4" opacity="0.35" />
    </>
  ),

  // A magnifier over a page whose lines run out.
  search: (
    <>
      <path d="M17 10h18l10 10v10" opacity="0.5" />
      <path d="M35 10v10h10" opacity="0.5" />
      <path d="M17 10v38a2 2 0 0 0 2 2h9" opacity="0.5" />
      <path d="M23 24h12M23 31h8" opacity="0.4" />
      <circle cx="38" cy="40" r="11" />
      <path d="M46 48l8 8" />
    </>
  ),
};
