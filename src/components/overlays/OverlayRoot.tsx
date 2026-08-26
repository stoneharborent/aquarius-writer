import { useOverlay } from "@/state/overlayStore";
import { CommandPalette } from "./CommandPalette";
import { Compile } from "./Compile";
import { Today } from "./Today";
import { Settings } from "./Settings";
import { Graph } from "./Graph";
import { CheatSheet } from "./CheatSheet";
import { FindReplace } from "./FindReplace";
import { TrashSheet } from "./TrashSheet";
import { VersionDiff } from "./VersionDiff";
import { ScreenplayPreview } from "./ScreenplayPreview";

export function OverlayRoot() {
  const active = useOverlay((s) => s.active);
  if (!active) return null;
  if (active === "palette") return <CommandPalette />;
  if (active === "compile") return <Compile />;
  if (active === "today") return <Today />;
  if (active === "settings") return <Settings />;
  if (active === "graph") return <Graph />;
  if (active === "cheatsheet") return <CheatSheet />;
  if (active === "find") return <FindReplace />;
  if (active === "trash") return <TrashSheet />;
  if (active === "version-diff") return <VersionDiff />;
  if (active === "screenplay-preview") return <ScreenplayPreview />;
  return null;
}
