import type { TitlePage as TP } from "@/lib/fountain";
import "./TitlePage.css";

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
