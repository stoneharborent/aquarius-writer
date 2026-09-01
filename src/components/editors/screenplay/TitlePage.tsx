// The Title Page tab — PARITY row 12, SWIFT-AUDIT §2.1 ("Title Page as a
// second tab on the same .fountain file (Title/Credit/Author/Source/Draft
// date/Contact, written into the Fountain title block)").
//
// It is a **page, not a form**: the same sheet the script sits on, with the
// six fields where a title page puts them, each one an input that only looks
// like an input once you are in it. The alternative — a labelled settings
// form — would be the one place in the app where a document is edited
// somewhere other than on its page.
//
// Everything it writes goes through the normal buffer: `onChange` hands the
// whole file back to `editorStore.edit`, which debounces, snapshots and
// conflict-guards it exactly as a keystroke in the script does. No frontmatter
// is involved and none is created — a `.fountain` file's metadata is its
// title block (`withTitleBlock` in `lib/fountain.ts`), and unknown keys in
// that block round-trip untouched.

import { useMemo } from "react";
import {
  TITLE_FIELDS,
  canonicalTitleField,
  mergeTitleEntries,
  parseTitleBlock,
  withTitleBlock,
  type TitleField,
  type TitlePage as TP,
} from "@/lib/fountain";
import "./TitlePage.css";

/** The read-only render, still used by the print-preview overlay. */
export function TitlePage({ tp }: { tp: TP }) {
  if (!tp || Object.keys(tp).length === 0) return null;
  return (
    <div className="tp">
      <h1 className="tp-title">{tp.Title ?? "Untitled"}</h1>
      {tp.Credit && <div className="tp-credit">{tp.Credit}</div>}
      {tp.Author && <div className="tp-author">{tp.Author}</div>}
      {tp.Source && <div className="tp-source">{tp.Source}</div>}
      <div className="tp-foot">
        {tp["Draft date"] && <span>Draft · {tp["Draft date"]}</span>}
        {tp.Contact && <span className="tp-contact">{tp.Contact}</span>}
      </div>
    </div>
  );
}

const PLACEHOLDER: Record<TitleField, string> = {
  Title: "UNTITLED",
  Credit: "Written by",
  Author: "Your name",
  Source: "Based on…",
  "Draft date": "First draft, 31 Aug 2026",
  Contact: "Name\nEmail\nPhone",
};

interface EditorProps {
  /** The WHOLE file — title block and script. */
  value: string;
  /** The whole file back, with the title block rewritten. */
  onChange: (next: string) => void;
  readOnly?: boolean;
}

export function TitlePageEditor({ value, onChange, readOnly = false }: EditorProps) {
  const entries = useMemo(() => parseTitleBlock(value).entries, [value]);

  const fields = useMemo(() => {
    const out = {} as Record<TitleField, string>;
    for (const f of TITLE_FIELDS) out[f] = "";
    for (const [key, v] of entries) {
      const canon = canonicalTitleField(key);
      if (canon) out[canon] = v;
    }
    return out;
  }, [entries]);

  function set(field: TitleField, next: string) {
    if (readOnly) return;
    onChange(withTitleBlock(value, mergeTitleEntries(entries, { [field]: next })));
  }

  return (
    <div className="tpe-canvas">
      <div className="tpe-sheet">
        <div className="tpe-block tpe-block-centre">
          <input
            className="tpe-field tpe-title"
            value={fields.Title}
            placeholder={PLACEHOLDER.Title}
            onChange={(e) => set("Title", e.target.value)}
            readOnly={readOnly}
            aria-label="Title"
            spellCheck={false}
          />
          <input
            className="tpe-field tpe-credit"
            value={fields.Credit}
            placeholder={PLACEHOLDER.Credit}
            onChange={(e) => set("Credit", e.target.value)}
            readOnly={readOnly}
            aria-label="Credit"
          />
          <input
            className="tpe-field tpe-author"
            value={fields.Author}
            placeholder={PLACEHOLDER.Author}
            onChange={(e) => set("Author", e.target.value)}
            readOnly={readOnly}
            aria-label="Author"
          />
          <input
            className="tpe-field tpe-source"
            value={fields.Source}
            placeholder={PLACEHOLDER.Source}
            onChange={(e) => set("Source", e.target.value)}
            readOnly={readOnly}
            aria-label="Source"
          />
        </div>

        {/* A title page's feet: draft on the left, contact on the right,
            which is where a reader's eye and a producer's assistant look. */}
        <div className="tpe-feet">
          <input
            className="tpe-field tpe-draft"
            value={fields["Draft date"]}
            placeholder={PLACEHOLDER["Draft date"]}
            onChange={(e) => set("Draft date", e.target.value)}
            readOnly={readOnly}
            aria-label="Draft date"
          />
          <textarea
            className="tpe-field tpe-contact"
            value={fields.Contact}
            placeholder={PLACEHOLDER.Contact}
            onChange={(e) => set("Contact", e.target.value)}
            readOnly={readOnly}
            aria-label="Contact"
            rows={3}
          />
        </div>
      </div>

      <p className="tpe-note">
        These six fields are the Fountain title block at the top of this file.
        Anything else the block already carries — a copyright line, a revision
        note — is left exactly where it is.
      </p>
    </div>
  );
}
