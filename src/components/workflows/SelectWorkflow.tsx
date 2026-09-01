import { useEffect, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import {
  BookIcon,
  ChevronIcon,
  FileIcon,
  FolderIcon,
  PlusIcon,
  ScreenplayIcon,
} from "@/icons";
import { useVault } from "@/state/vaultStore";
import { useNotices } from "@/state/noticeStore";
import { EmptyState } from "@/components/shell/EmptyState";
import { DEFAULT_ACCENT, normalizeAccent } from "@/theme/theme";
import type { WorkflowKind, WorkflowSummary } from "@/types/vault";
// The app's own mark, from the set `npx tauri icon` generates — the same image
// the taskbar and the dock show, so the welcome screen cannot drift away from
// the app's identity the way a second, hand-drawn logo would. 256px, and Vite
// inlines or fingerprints it like any other asset.
import appMark from "../../../src-tauri/icons/128x128@2x.png";
import "./SelectWorkflow.css";

const KIND_ICON: Record<WorkflowKind, (p: { size?: number; color?: string; strokeWidth?: number }) => JSX.Element> = {
  novel: BookIcon,
  screenplay: ScreenplayIcon,
  worldbuilding: FolderIcon,
  notes: FileIcon,
};

const KINDS: { value: WorkflowKind; label: string; hint: string }[] = [
  { value: "novel", label: "Novel", hint: "Drafts, Characters, Worldbuilding, Research" },
  { value: "screenplay", label: "Screenplay", hint: "Episodes, Characters, Research" },
  { value: "worldbuilding", label: "Worldbuilding", hint: "Characters, Places, History, Research" },
  { value: "notes", label: "Notes", hint: "One folder, one starting note" },
];

/**
 * How long a folder picker may sit there before we suspect it never opened.
 *
 * This is not a timeout — nothing is cancelled, and a writer browsing their
 * disk for two minutes is normal. It only decides when to offer the typed-path
 * fallback, because the failure we are guarding against (a native dialog that
 * opens behind the window, or never opens at all) looks exactly like a writer
 * taking their time.
 */
const PICKER_PATIENCE_MS = 15_000;

/**
 * How many recent workflows the list shows. `vault_list_workflows` returns
 * them most-recently-touched first (the registry's `touch` on every open), so
 * this is a cut off the front, not a sample. Five, because the list sits above
 * the fold with the three cards and the footer, and a sixth row starts pushing
 * "local-first · no telemetry" off a 900px window.
 */
const RECENTS = 5;

/**
 * Dropping a folder from the OS onto the welcome window.
 *
 * Swift opens the workflow (SWIFT-AUDIT §2.6). This side **cannot**, and the
 * reason is worth writing down so nobody spends another afternoon on it.
 *
 * The events do arrive: `dragDropEnabled` is `false` in both window configs
 * (NOTES §18a), so Tauri's native file-drop handler is out of the way and the
 * page gets real HTML5 `dragover` / `drop`. What arrives with them is the
 * problem. A dropped directory in a webview gives you:
 *
 *   - `DataTransferItem.webkitGetAsEntry()` → a `FileSystemDirectoryEntry`
 *     whose `fullPath` is `/TheFolderName`. That is a path *inside the drag's
 *     own sandboxed root*, not on disk. It never contains the parent.
 *   - `DataTransfer.files` → for a directory, usually nothing at all
 *     (`getAsFile()` on a folder is a 0-byte `File` at best), and `File.name`
 *     is again only the leaf.
 *   - `File.path` — the nonstandard property Electron adds and everyone
 *     reaches for. Neither WKWebView nor WebKitGTK has it, and Tauri 2 does
 *     not inject it: the supported route to a real path is Tauri's *native*
 *     drop event, which is exactly the thing that had to be turned off to get
 *     tree drag working at all.
 *
 * So a real filesystem path is not obtainable here, and guessing one from a
 * folder name would be worse than not trying. This function reads whatever is
 * actually there, and `path` is `null` on every build we ship. It is still
 * *asked for* rather than assumed absent — if a future Tauri exposes it, the
 * drop starts working with no other change — and when it is null the welcome
 * screen degrades: it names the folder, points at "Open existing", and opens
 * the type-a-path box underneath. See NOTES §24a.
 */
interface DroppedFolder {
  /** The folder's leaf name, when the drop carried one. */
  name: string | null;
  /** A real filesystem path — `null` in every shipping build. See above. */
  path: string | null;
  /** False when what landed was a plain file, not a directory. */
  isDirectory: boolean;
}

function readDroppedFolder(dt: DataTransfer): DroppedFolder | null {
  const items = Array.from(dt.items ?? []).filter((i) => i.kind === "file");
  const files = Array.from(dt.files ?? []);
  if (items.length === 0 && files.length === 0) return null;

  let isDirectory = false;
  let name: string | null = null;

  for (const item of items) {
    // Prefixed and unprefixed: WebKit ships the `webkit` one, and the spec
    // name is landing gradually.
    const get = (item as DataTransferItem & {
      getAsEntry?: () => { isDirectory: boolean; name: string } | null;
    });
    const entry = get.getAsEntry?.() ?? item.webkitGetAsEntry?.();
    if (entry) {
      isDirectory = entry.isDirectory;
      name = entry.name;
      break;
    }
  }

  const file = files[0];
  if (name === null && file) name = file.name;
  // A directory dropped as a `File` has no type and no size — the only tell
  // left when `webkitGetAsEntry` gave us nothing.
  if (!isDirectory && file && file.type === "" && file.size === 0) isDirectory = true;

  // Asked for, never assumed. Nothing we ship answers this.
  const nonstandard = file as (File & { path?: unknown }) | undefined;
  const path = typeof nonstandard?.path === "string" && nonstandard.path.length > 0
    ? nonstandard.path
    : null;

  return { name, path, isDirectory };
}

/** Does this drag carry files at all? Text selections and links do not. */
function carriesFiles(dt: DataTransfer): boolean {
  return Array.from(dt.types ?? []).includes("Files");
}

export function SelectWorkflow() {
  const {
    workflows,
    fetchWorkflows,
    openWorkflow,
    addWorkflowFromFolder,
    addWorkflowByPath,
    createWorkflow,
    openSampleWorkflow,
    pending,
  } = useVault();

  /** Which panel is open under the cards: the new-workflow form, or neither. */
  const [panel, setPanel] = useState<"create" | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<WorkflowKind>("novel");
  const [nameError, setNameError] = useState<string | null>(null);

  /** The escape hatch, revealed when a picker seems not to have appeared. */
  const [showPathEntry, setShowPathEntry] = useState(false);
  const [typedPath, setTypedPath] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);

  const notices = useNotices();
  /** A folder is being dragged over the window right now. */
  const [dropping, setDropping] = useState(false);
  const pathInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchWorkflows();
  }, [fetchWorkflows]);

  useEffect(() => {
    if (panel === "create") nameInput.current?.focus();
  }, [panel]);

  // If a folder picker has been "open" this long, offer another way in.
  useEffect(() => {
    if (pending !== "picking") return;
    const t = window.setTimeout(() => setShowPathEntry(true), PICKER_PATIENCE_MS);
    return () => window.clearTimeout(t);
  }, [pending]);

  const busy = pending !== null;

  async function submitCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError("Give the workflow a name first");
      return;
    }
    setNameError(null);
    const ok = await createWorkflow(trimmed, kind);
    if (ok) {
      setPanel(null);
      setName("");
    }
  }

  async function submitPath() {
    const p = typedPath.trim();
    if (!p) return;
    if (await addWorkflowByPath(p)) setTypedPath("");
  }

  /**
   * A folder dropped onto the window. In practice this always lands in the
   * "no path" branch — see `readDroppedFolder` for why — so the important half
   * of this function is the graceful degrade, not the happy path.
   */
  function onDrop(e: ReactDragEvent) {
    e.preventDefault();
    setDropping(false);
    const dropped = readDroppedFolder(e.dataTransfer);
    if (!dropped) return;

    if (!dropped.isDirectory) {
      notices.say(
        "A workflow is a folder, not a file",
        dropped.name ? `Drop the folder “${dropped.name}” is in instead.` : undefined,
      );
      return;
    }

    if (dropped.path) {
      void addWorkflowByPath(dropped.path);
      return;
    }

    // The honest failure. Name what was dropped so it is clearly *this* drop
    // being answered, say the one true reason, and put the two ways in right
    // under the pointer.
    notices.say(
      dropped.name ? `Can’t open “${dropped.name}” from a drop` : "Can’t open a folder from a drop",
      "This window can see the folder’s name but not where it is on disk. Use “Open existing”, or type the path below.",
    );
    setPanel(null);
    setShowPathEntry(true);
    // Let the box render before reaching for it.
    window.setTimeout(() => pathInput.current?.focus(), 0);
  }

  return (
    <div
      className={`select-workflow${dropping ? " dropping" : ""}`}
      onDragOver={(e) => {
        if (!carriesFiles(e.dataTransfer)) return;
        // Without this the engine treats the page as a non-target and never
        // fires `drop` — which is the whole reason a folder drop looked
        // ignored before the notice existed.
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDropping(true);
      }}
      onDragLeave={(e) => {
        // `dragleave` also fires crossing into a child (a card, the recents
        // list), so only a leave that actually exits the window counts.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDropping(false);
      }}
      onDrop={onDrop}
    >
      <div className="sw-glow" />

      {/* The drag is acknowledged even though the drop cannot finish the job.
          A window that visibly reacts and then explains beats one that lets a
          folder fall through it — the second reads as a broken app, which is
          the impression this whole screen was rebuilt to stop giving. */}
      {dropping && (
        <div className="sw-dropveil" aria-hidden="true">
          <div className="sw-dropveil-card">
            <FolderIcon size={20} color="var(--accent)" strokeWidth={1.4} />
            <span>Drop a folder — Aquarius will show you how to open it</span>
          </div>
        </div>
      )}

      <div className="sw-scroll">
        <div className="sw-inner">
          {/* The AppMark on its radial accent glow — Swift's welcome screen,
              SWIFT-AUDIT §1.6. The glow is a sibling rather than a
              `box-shadow` so it can be much wider than the mark and still
              fade to nothing, which is what makes it read as light rather
              than as a border. */}
          <div className="sw-logo">
            <span className="sw-logo-glow" aria-hidden="true" />
            <img className="sw-logo-mark" src={appMark} alt="" width={64} height={64} />
          </div>
          <h1 className="sw-title">Welcome to Aquarius Writer</h1>
          <p className="sw-sub">
            Open a workflow to get started. A workflow is a folder of notes,
            drafts, and references — your novel, your screenplay, a world
            you're building.
          </p>

          <div className="sw-cards">
            <WelcomeCard
              icon={<FolderIcon size={17} color="#fff" strokeWidth={1.5} />}
              title="Open existing"
              subtitle={pending === "picking" ? "Choosing a folder…" : "Point to any folder on your machine."}
              primary
              busy={pending === "picking"}
              disabled={busy}
              onClick={() => { setPanel(null); void addWorkflowFromFolder(); }}
            />
            <WelcomeCard
              icon={<PlusIcon size={17} color="var(--ink-soft)" strokeWidth={1.5} />}
              title="Create new"
              subtitle={pending === "creating" ? "Making the folder…" : "Start a fresh workflow with a template."}
              busy={pending === "creating"}
              disabled={busy}
              active={panel === "create"}
              onClick={() => setPanel(panel === "create" ? null : "create")}
            />
            <WelcomeCard
              icon={<BookIcon size={17} color="var(--ink-soft)" strokeWidth={1.5} />}
              title="Try the sample"
              subtitle={pending === "sample" ? "Writing it to disk…" : "A small literary workflow to explore."}
              busy={pending === "sample"}
              disabled={busy}
              onClick={() => { setPanel(null); void openSampleWorkflow(); }}
            />
          </div>

          {panel === "create" && (
            <div className="sw-panel">
              <label className="sw-field">
                <span className="sw-field-label">Name</span>
                <input
                  ref={nameInput}
                  className="sw-input"
                  value={name}
                  placeholder="Lantern, Lantern"
                  onChange={(e) => { setName(e.target.value); setNameError(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter") void submitCreate(); }}
                />
              </label>

              <span className="sw-field-label">Shape</span>
              <div className="sw-kinds">
                {KINDS.map((k) => (
                  <button
                    key={k.value}
                    className={`sw-kind${kind === k.value ? " on" : ""}`}
                    onClick={() => setKind(k.value)}
                    title={k.hint}
                  >
                    {k.label}
                  </button>
                ))}
              </div>
              <p className="sw-hint">{KINDS.find((k) => k.value === kind)!.hint}</p>

              {nameError && <p className="sw-error">{nameError}</p>}

              <div className="sw-panel-actions">
                <button className="sw-btn ghost" onClick={() => setPanel(null)} disabled={busy}>
                  Cancel
                </button>
                <button className="sw-btn" onClick={() => void submitCreate()} disabled={busy}>
                  {pending === "creating" ? "Creating…" : "Choose a location…"}
                </button>
              </div>
              <p className="sw-hint">
                The next step picks the folder to keep it in. Nothing is written
                until you choose one.
              </p>
            </div>
          )}

          <div className="sw-recent-head">
            Recent workflows
            <span className="sw-recent-rule" />
          </div>

          <div className="sw-recent">
            {workflows.length === 0 ? (
              <EmptyState
                size="inline"
                art="book"
                headline="No workflows yet"
                subline="Open a folder you already write in, start a fresh one, or try the sample."
              />
            ) : (
              workflows.slice(0, RECENTS).map((w, i) => (
                <RecentRow
                  key={w.id}
                  w={w}
                  isLast={i === Math.min(workflows.length, RECENTS) - 1}
                  onClick={() => void openWorkflow(w.id)}
                />
              ))
            )}
          </div>

          {/* The escape hatch. Hidden until a picker looks stuck, or until
              someone asks for it — a path is a worse first offer than a
              dialog, and a much better second one. */}
          <div className="sw-fallback">
            {showPathEntry ? (
              <div className="sw-panel">
                <span className="sw-field-label">Open a folder by path</span>
                <p className="sw-hint">
                  Use this if the folder chooser did not appear. Type the full
                  path to the folder, for example <code>~/Writing/My Novel</code>.
                </p>
                <div className="sw-row">
                  <input
                    ref={pathInput}
                    className="sw-input"
                    value={typedPath}
                    placeholder="~/Writing/My Novel"
                    spellCheck={false}
                    onChange={(e) => setTypedPath(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void submitPath(); }}
                  />
                  <button className="sw-btn" onClick={() => void submitPath()} disabled={busy}>
                    {pending === "opening" ? "Opening…" : "Open"}
                  </button>
                </div>
              </div>
            ) : (
              <button className="sw-textlink" onClick={() => setShowPathEntry(true)}>
                Open a folder by typing its path instead
              </button>
            )}
          </div>

          <div className="sw-footer">
            Aquarius Writer · local-first · no telemetry
          </div>
        </div>
      </div>
    </div>
  );
}

function WelcomeCard({
  icon, title, subtitle, primary, active, busy, disabled, onClick,
}: {
  icon: JSX.Element;
  title: string;
  subtitle: string;
  primary?: boolean;
  active?: boolean;
  busy?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      className={`sw-card${primary ? " primary" : ""}${active ? " active" : ""}${busy ? " busy" : ""}`}
      onClick={onClick}
      disabled={disabled}
      aria-busy={busy}
    >
      <div className="sw-card-icon">{icon}</div>
      <div className="sw-card-title">{title}</div>
      <div className="sw-card-sub">{subtitle}</div>
    </button>
  );
}

function RecentRow({
  w, isLast, onClick,
}: {
  w: WorkflowSummary;
  isLast: boolean;
  onClick: () => void;
}) {
  const Ic = KIND_ICON[w.kind] ?? FileIcon;
  return (
    <button
      className={`sw-recent-row${isLast ? " last" : ""}`}
      data-color={normalizeAccent(w.color) ?? DEFAULT_ACCENT}
      onClick={onClick}
    >
      <span className="sw-recent-icon">
        <Ic size={13} strokeWidth={1.4} />
      </span>
      <span className="sw-recent-main">
        <span className="sw-recent-name">{w.name}</span>
        <span className="sw-recent-path">{w.path}</span>
      </span>
      <span className="sw-recent-meta">{w.items} items · {w.updated}</span>
      <ChevronIcon size={11} color="var(--ink-mute)" strokeWidth={1.4} />
    </button>
  );
}
