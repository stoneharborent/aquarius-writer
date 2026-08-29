//! The vault: workflow registry, workflow metadata, and the file tree.

pub mod frontmatter;
pub mod ops;
pub mod paths;
pub mod registry;
pub mod scaffold;
pub mod search;
pub mod tree;
pub mod workflow;

use crate::model::WorkflowSummary;
use std::path::Path;
use std::time::SystemTime;

/// Build the picker row for a workflow folder.
pub fn summarize(root: &Path, active: bool) -> std::io::Result<(WorkflowSummary, crate::model::Workflow)> {
    let (wf, _) = workflow::read_or_create(root)?;
    let (_, stats) = tree::walk(root, &wf.title)?;
    let summary = WorkflowSummary {
        id: wf.id.clone(),
        name: wf.title.clone(),
        path: paths::display_path(root),
        kind: wf.kind.clone(),
        items: stats.items,
        active: if active { Some(true) } else { None },
        color: wf.settings.accent.clone(),
        updated: relative_time(stats.newest),
    };
    Ok((summary, wf))
}

/// "now" | "12m ago" | "5h ago" | "yesterday" | "3d ago" | "Apr 12"
pub fn relative_time(at: Option<SystemTime>) -> String {
    let Some(at) = at else { return "—".into() };
    let dt: chrono::DateTime<chrono::Local> = at.into();
    let now = chrono::Local::now();
    let secs = (now - dt).num_seconds();
    match secs {
        s if s < 0 => "now".into(),
        s if s < 90 => "now".into(),
        s if s < 3600 => format!("{}m ago", s / 60),
        s if s < 86_400 => format!("{}h ago", s / 3600),
        s if s < 172_800 => "yesterday".into(),
        s if s < 604_800 => format!("{}d ago", s / 86_400),
        _ => dt.format("%b %-d").to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;
    use std::time::Duration;

    #[test]
    fn relative_time_reads_like_the_mock() {
        let now = SystemTime::now();
        assert_eq!(relative_time(None), "—");
        assert_eq!(relative_time(Some(now)), "now");
        assert_eq!(relative_time(Some(now - Duration::from_secs(60 * 12))), "12m ago");
        assert_eq!(relative_time(Some(now - Duration::from_secs(3600 * 5))), "5h ago");
        assert_eq!(relative_time(Some(now - Duration::from_secs(86_400 + 60))), "yesterday");
        assert_eq!(relative_time(Some(now - Duration::from_secs(86_400 * 3))), "3d ago");
        // Older than a week falls back to a date, whatever today happens to be.
        let old = relative_time(Some(now - Duration::from_secs(86_400 * 40)));
        assert!(!old.ends_with("ago"), "expected a date, got {old}");
    }

    #[test]
    fn summarize_fills_the_picker_row() {
        let t = TempDir::new("summarize");
        t.write("Drafts/Ch_01.md", "---\ntitle: One\n---\n\nbody");
        t.write("Drafts/Ch_02.md", "body");
        let (summary, wf) = summarize(t.path(), true).unwrap();
        assert_eq!(summary.id, wf.id);
        assert_eq!(summary.kind, "novel");
        assert_eq!(summary.items, 2);
        assert_eq!(summary.color, "blue");
        assert_eq!(summary.active, Some(true));
        assert_eq!(summary.updated, "now");
    }
}
