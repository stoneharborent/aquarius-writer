import { useEffect, useRef, useState } from "react";
import {
  BookIcon,
  ChevronIcon,
  FileIcon,
  FolderIcon,
  PlusIcon,
  ScreenplayIcon,
  SparkleIcon,
} from "@/icons";
import { useVault } from "@/state/vaultStore";
import type { WorkflowKind, WorkflowSummary } from "@/types/vault";
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

  return (
    <div className="select-workflow">
      <div className="sw-glow" />

      <div className="sw-scroll">
        <div className="sw-inner">
          <div className="sw-logo">
            <SparkleIcon size={26} color="#fff" strokeWidth={1.6} />
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
              <p className="sw-empty">
                Nothing yet. Open a folder, create a workflow, or try the sample.
              </p>
            ) : (
              workflows.slice(0, 3).map((w, i) => (
                <RecentRow key={w.id} w={w} isLast={i === Math.min(workflows.length, 3) - 1}
                  onClick={() => void openWorkflow(w.id)} />
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
      data-color={w.color}
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
