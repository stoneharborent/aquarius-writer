import { useEffect } from "react";
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

export function SelectWorkflow() {
  const { workflows, fetchWorkflows, openWorkflow } = useVault();

  useEffect(() => {
    fetchWorkflows();
  }, [fetchWorkflows]);

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
            <WelcomeCard icon={<FolderIcon size={17} color="#fff" strokeWidth={1.5} />} title="Open existing"
              subtitle="Point to any folder on your machine." primary />
            <WelcomeCard icon={<PlusIcon size={17} color="var(--ink-soft)" strokeWidth={1.5} />} title="Create new"
              subtitle="Start a fresh workflow with a template." />
            <WelcomeCard icon={<BookIcon size={17} color="var(--ink-soft)" strokeWidth={1.5} />} title="Try the sample"
              subtitle="A small literary workflow to explore."
              onClick={() => openWorkflow("lantern")} />
          </div>

          <div className="sw-recent-head">
            Recent workflows
            <span className="sw-recent-rule" />
          </div>

          <div className="sw-recent">
            {workflows.slice(0, 3).map((w, i) => (
              <RecentRow key={w.id} w={w} isLast={i === 2}
                onClick={() => openWorkflow(w.id)} />
            ))}
          </div>

          <div className="sw-footer">
            Aquarius Writer 1.0 · local-first · no telemetry
          </div>
        </div>
      </div>
    </div>
  );
}

function WelcomeCard({
  icon, title, subtitle, primary, onClick,
}: {
  icon: JSX.Element;
  title: string;
  subtitle: string;
  primary?: boolean;
  onClick?: () => void;
}) {
  return (
    <button className={`sw-card${primary ? " primary" : ""}`} onClick={onClick}>
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
