//! Writing sessions — how many words were written today, and on which days.
//!
//! HANDOFF §3 sketched `.aquarius/sessions/` in May 2026 and nothing ever built
//! it, so both Aquarius Writers shipped a Today panel painted from hardcoded
//! sample data (docs/PARITY.md, "Today panel — parity in fakeness"). This is the
//! real thing, and because the Swift app has no format of its own the shape
//! below is proposed as the **shared contract** — see docs/NOTES.md §21.
//!
//! ```text
//! .aquarius/
//!   sessions/
//!     2026-08-31.json     ← one file per calendar day, local time
//! ```
//!
//! ```json
//! {
//!   "date": "2026-08-31",
//!   "goal": 1000,
//!   "words": {
//!     "Drafts/Ch_03.md": { "start": 2410, "latest": 2822 }
//!   },
//!   "updatedAt": 1756662000000
//! }
//! ```
//!
//! `start` is a document's word count the first time it was observed that day;
//! `latest` is the most recent. The day's written total is
//! `Σ max(0, latest − start)` — deleting words does not go negative and does not
//! eat another document's gain.
//!
//! Three properties are deliberate, because this file will outlive the code
//! that writes it:
//!
//! * **Append-friendly.** A day is only ever added to; nothing rewrites
//!   yesterday.
//! * **Forgiving.** Unknown keys survive a round trip (`extra`), so a future
//!   version — or the Swift app — can add fields without this one dropping
//!   them.
//! * **Never fatal.** A corrupt day file reads as an empty day and is replaced
//!   on the next write. A writing streak is not worth an error dialog.

use crate::fs_ops::atomic::write_atomic;
use crate::vault::paths::aq_dir;
use chrono::{Days, Local, NaiveDate};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// The goal a vault falls back to when `workflow.json` has none — the same
/// number `model::Goals::default()` uses.
pub const DEFAULT_GOAL: u32 = 1000;

/// How many days the Today panel's sparkline shows.
pub const SPARK_DAYS: usize = 14;

/// Ceiling on a streak walk, so a vault with a decade of history cannot turn
/// one panel open into thousands of file reads.
const MAX_STREAK_DAYS: u32 = 3660;

// ── the on-disk shapes ───────────────────────────────────────────────────

/// One document's word count across a day: where it started, where it is now.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DocWords {
    #[serde(default)]
    pub start: usize,
    #[serde(default)]
    pub latest: usize,
    #[serde(flatten, default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// One `YYYY-MM-DD.json`.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DaySession {
    pub date: String,
    /// The daily word goal as it stood on this day. History, not configuration:
    /// changing the goal today does not rewrite what last week was measured
    /// against.
    #[serde(default)]
    pub goal: u32,
    #[serde(default)]
    pub words: BTreeMap<String, DocWords>,
    /// Epoch milliseconds of the last observation.
    #[serde(default)]
    pub updated_at: i64,
    #[serde(flatten, default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra: BTreeMap<String, serde_json::Value>,
}

// ── what the UI and the MCP tool read ────────────────────────────────────

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DocDelta {
    pub path: String,
    pub words: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DaySummary {
    pub date: String,
    pub goal: u32,
    pub written: usize,
    /// Per-document gains, biggest first. Documents that lost words or stood
    /// still are left out — a list of zeroes is not information.
    pub docs: Vec<DocDelta>,
}

/// Everything the Today panel needs, in one read.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionsView {
    pub today: DaySummary,
    /// Oldest first, one entry per day including the empty ones, ending today.
    pub days: Vec<DaySummary>,
    pub streak: u32,
}

// ── paths and dates ──────────────────────────────────────────────────────

fn sessions_dir(root: &Path) -> PathBuf {
    aq_dir(root).join("sessions")
}

fn day_path(root: &Path, date: &str) -> PathBuf {
    sessions_dir(root).join(format!("{date}.json"))
}

fn local_date(at_ms: i64) -> NaiveDate {
    chrono::DateTime::from_timestamp_millis(at_ms)
        .map(|dt| dt.with_timezone(&Local).date_naive())
        .unwrap_or_else(|| Local::now().date_naive())
}

fn key_of(date: NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}

/// The calendar day an instant falls in, in the writer's own timezone.
///
/// Local, not UTC, on purpose: a writer who works until one in the morning
/// expects those words to count for the day they think they are in.
pub fn date_key(at_ms: i64) -> String {
    key_of(local_date(at_ms))
}

// ── reading and writing a day ────────────────────────────────────────────

/// One day's file. A missing or unreadable one reads as an empty day.
pub fn read_day(root: &Path, date: &str) -> DaySession {
    let mut day: DaySession = fs::read_to_string(day_path(root, date))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    if day.date.is_empty() {
        day.date = date.to_string();
    }
    day
}

fn write_day(root: &Path, day: &DaySession) -> std::io::Result<()> {
    fs::create_dir_all(sessions_dir(root))?;
    let json = serde_json::to_string_pretty(day).map_err(std::io::Error::other)?;
    write_atomic(&day_path(root, &day.date), format!("{json}\n").as_bytes())?;
    Ok(())
}

/// Turn a day into what a panel paints. `fallback_goal` covers a day file
/// written before goals were recorded, or one that never was.
pub fn summarize(day: &DaySession, fallback_goal: u32) -> DaySummary {
    let mut docs: Vec<DocDelta> = day
        .words
        .iter()
        .map(|(path, w)| DocDelta {
            path: path.clone(),
            words: w.latest.saturating_sub(w.start),
        })
        .filter(|d| d.words > 0)
        .collect();
    // Biggest gain first; ties by path so the list is stable between renders.
    docs.sort_by(|a, b| b.words.cmp(&a.words).then_with(|| a.path.cmp(&b.path)));
    DaySummary {
        date: day.date.clone(),
        goal: if day.goal == 0 { fallback_goal } else { day.goal },
        written: docs.iter().map(|d| d.words).sum(),
        docs,
    }
}

/// Record what a document's word count is *now*.
///
/// The first observation of a document on a given day sets its baseline, so
/// opening a 2,400-word chapter does not read as writing 2,400 words. Every
/// later one moves `latest`. Called from the save path, which is already
/// debounced — this is never per keystroke.
pub fn note(
    root: &Path,
    rel: &str,
    words: usize,
    goal: u32,
    at_ms: i64,
) -> std::io::Result<DaySummary> {
    let date = date_key(at_ms);
    let mut day = read_day(root, &date);
    day.date = date;
    day.goal = if goal == 0 { DEFAULT_GOAL } else { goal };
    day.updated_at = at_ms;
    match day.words.get_mut(rel) {
        Some(entry) => entry.latest = words,
        None => {
            day.words.insert(
                rel.to_string(),
                DocWords { start: words, latest: words, extra: BTreeMap::new() },
            );
        }
    }
    write_day(root, &day)?;
    Ok(summarize(&day, goal))
}

/// Write today's goal into today's file, so the day is measured against the
/// number that was actually in force while it was being written.
pub fn set_goal(root: &Path, goal: u32, at_ms: i64) -> std::io::Result<DaySummary> {
    let date = date_key(at_ms);
    let mut day = read_day(root, &date);
    day.date = date;
    day.goal = if goal == 0 { DEFAULT_GOAL } else { goal };
    if day.updated_at == 0 {
        day.updated_at = at_ms;
    }
    write_day(root, &day)?;
    Ok(summarize(&day, goal))
}

/// Today, summarised.
pub fn today(root: &Path, goal: u32, now_ms: i64) -> DaySummary {
    summarize(&read_day(root, &date_key(now_ms)), goal)
}

/// The last `days` calendar days, oldest first, ending today. Days with no
/// file are present and empty — the sparkline needs the gaps.
pub fn range(root: &Path, days: usize, goal: u32, now_ms: i64) -> Vec<DaySummary> {
    let today = local_date(now_ms);
    let n = days.clamp(1, 365);
    (0..n)
        .rev()
        .map(|back| {
            let date = today
                .checked_sub_days(Days::new(back as u64))
                .unwrap_or(today);
            summarize(&read_day(root, &key_of(date)), goal)
        })
        .collect()
}

/// Consecutive days with any words written, ending today **or yesterday**.
///
/// Yesterday counts as an ending because a writer who has not sat down yet
/// this morning has not lost their run — Swift's Today panel makes the same
/// promise in its sample copy. A day with a net loss of words is a day with
/// nothing written, which is the one place this is stricter than it looks.
pub fn streak(root: &Path, goal: u32, now_ms: i64) -> u32 {
    let wrote = |date: NaiveDate| summarize(&read_day(root, &key_of(date)), goal).written > 0;
    let today = local_date(now_ms);
    let yesterday = today.checked_sub_days(Days::new(1)).unwrap_or(today);

    let mut cursor = if wrote(today) {
        today
    } else if wrote(yesterday) {
        yesterday
    } else {
        return 0;
    };

    let mut count = 0u32;
    while count < MAX_STREAK_DAYS && wrote(cursor) {
        count += 1;
        match cursor.checked_sub_days(Days::new(1)) {
            Some(previous) => cursor = previous,
            None => break,
        }
    }
    count
}

/// Everything the Today panel asks for, in one call.
pub fn view(root: &Path, days: usize, goal: u32, now_ms: i64) -> SessionsView {
    SessionsView {
        today: today(root, goal, now_ms),
        days: range(root, days, goal, now_ms),
        streak: streak(root, goal, now_ms),
    }
}

// ── following a file when it is renamed or moved ─────────────────────────
//
// Sessions are keyed by path like the snapshot and comment stores, so they
// migrate with them — `aux_store::migrate_document` / `migrate_folder` call
// these in the same operation `vault::ops` performs the rename in.
//
// A **trashed** file is deliberately not migrated or forgotten: the words were
// written that day whatever happened to the file afterwards, and a Tuesday that
// quietly loses four hundred words because a chapter was cut on Friday would be
// a lie about the past.

/// Re-key one document across every day on record.
pub fn migrate_document(root: &Path, from_rel: &str, to_rel: &str) -> std::io::Result<()> {
    migrate(root, from_rel, to_rel, false)
}

/// The same, for a folder: every key inside it moves too.
pub fn migrate_folder(root: &Path, from_rel: &str, to_rel: &str) -> std::io::Result<()> {
    migrate(root, from_rel, to_rel, true)
}

fn migrate(root: &Path, from_rel: &str, to_rel: &str, folder: bool) -> std::io::Result<()> {
    if from_rel == to_rel || from_rel.is_empty() || to_rel.is_empty() {
        return Ok(());
    }
    let Ok(entries) = fs::read_dir(sessions_dir(root)) else {
        return Ok(());
    };
    let prefix = format!("{from_rel}/");
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(date) = path.file_stem().map(|s| s.to_string_lossy().to_string()) else {
            continue;
        };
        let mut day = read_day(root, &date);
        let mut next: BTreeMap<String, DocWords> = BTreeMap::new();
        let mut changed = false;
        for (key, words) in std::mem::take(&mut day.words) {
            let moved = if key == from_rel {
                changed = true;
                to_rel.to_string()
            } else if folder {
                match key.strip_prefix(&prefix) {
                    Some(rest) => {
                        changed = true;
                        format!("{to_rel}/{rest}")
                    }
                    None => key,
                }
            } else {
                key
            };
            merge_into(&mut next, moved, words);
        }
        day.words = next;
        if changed {
            write_day(root, &day)?;
        }
    }
    Ok(())
}

/// Add a document's counts to `map`, combining rather than overwriting.
///
/// The vault side de-duplicates names, so a move never lands on an occupied
/// path and this is close to unreachable. When it does happen, adding both
/// halves keeps the *day's total* exact: (a.latest + b.latest) − (a.start +
/// b.start) is a's gain plus b's gain.
fn merge_into(map: &mut BTreeMap<String, DocWords>, key: String, words: DocWords) {
    match map.get_mut(&key) {
        Some(existing) => {
            existing.start += words.start;
            existing.latest += words.latest;
        }
        None => {
            map.insert(key, words);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    /// 2026-08-31, mid-morning local time. Everything below is anchored to a
    /// fixed instant so a test never depends on when it runs.
    fn at(date: NaiveDate, hour: u32) -> i64 {
        date.and_hms_opt(hour, 0, 0)
            .unwrap()
            .and_local_timezone(Local)
            .earliest()
            .expect("a real local time")
            .timestamp_millis()
    }

    fn day(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
    }

    #[test]
    fn the_first_observation_of_a_day_is_a_baseline_not_a_gain() {
        let t = TempDir::new("sessions-baseline");
        let now = at(day(2026, 8, 31), 9);

        // Opening a 2,410-word chapter and saving it must not read as having
        // written 2,410 words.
        let first = note(t.path(), "Drafts/Ch_03.md", 2410, 1000, now).unwrap();
        assert_eq!(first.written, 0);
        assert!(first.docs.is_empty(), "a document that only stood still is not listed");

        let second = note(t.path(), "Drafts/Ch_03.md", 2822, 1000, now + 60_000).unwrap();
        assert_eq!(second.written, 412);
        assert_eq!(second.docs, vec![DocDelta { path: "Drafts/Ch_03.md".into(), words: 412 }]);
        assert_eq!(second.goal, 1000);
    }

    #[test]
    fn a_days_total_is_the_sum_of_every_documents_gain() {
        let t = TempDir::new("sessions-total");
        let now = at(day(2026, 8, 31), 9);
        for (path, start, end) in [
            ("Drafts/Ch_03.md", 2410, 2822),
            ("Characters/Imogen.md", 300, 480),
            ("Worldbuilding/Helmreach.md", 0, 120),
        ] {
            note(t.path(), path, start, 1000, now).unwrap();
            note(t.path(), path, end, 1000, now + 60_000).unwrap();
        }
        let summary = today(t.path(), 1000, now);
        assert_eq!(summary.written, 412 + 180 + 120);
        assert_eq!(
            summary.docs.iter().map(|d| d.path.as_str()).collect::<Vec<_>>(),
            vec!["Drafts/Ch_03.md", "Characters/Imogen.md", "Worldbuilding/Helmreach.md"],
            "biggest gain first"
        );
    }

    #[test]
    fn deleting_words_never_makes_a_day_negative_or_eats_another_documents_gain() {
        let t = TempDir::new("sessions-negative");
        let now = at(day(2026, 8, 31), 9);
        note(t.path(), "Drafts/Ch_01.md", 1000, 1000, now).unwrap();
        note(t.path(), "Drafts/Ch_01.md", 400, 1000, now + 1000).unwrap(); // a big cut
        note(t.path(), "Drafts/Ch_02.md", 0, 1000, now + 2000).unwrap();
        note(t.path(), "Drafts/Ch_02.md", 250, 1000, now + 3000).unwrap();

        let summary = today(t.path(), 1000, now);
        assert_eq!(summary.written, 250, "the cut counts as zero, not as −600");
        assert_eq!(summary.docs.len(), 1);
    }

    #[test]
    fn a_new_calendar_day_starts_a_new_file_and_a_new_baseline() {
        let t = TempDir::new("sessions-rollover");
        let monday = at(day(2026, 8, 31), 23);
        let tuesday = at(day(2026, 9, 1), 8);

        note(t.path(), "Drafts/Ch_03.md", 2410, 1000, monday).unwrap();
        note(t.path(), "Drafts/Ch_03.md", 2800, 1000, monday + 60_000).unwrap();
        // Same document, next morning: yesterday's finish is today's baseline.
        note(t.path(), "Drafts/Ch_03.md", 2800, 1000, tuesday).unwrap();
        note(t.path(), "Drafts/Ch_03.md", 2900, 1000, tuesday + 60_000).unwrap();

        assert_eq!(today(t.path(), 1000, monday).written, 390);
        assert_eq!(today(t.path(), 1000, tuesday).written, 100);

        assert!(t.path().join(".aquarius/sessions/2026-08-31.json").is_file());
        assert!(t.path().join(".aquarius/sessions/2026-09-01.json").is_file());
    }

    #[test]
    fn a_corrupt_day_file_reads_as_an_empty_day_and_is_replaced_not_fatal() {
        let t = TempDir::new("sessions-corrupt");
        let now = at(day(2026, 8, 31), 10);
        t.write(".aquarius/sessions/2026-08-31.json", "{ this is not json");

        assert_eq!(today(t.path(), 1000, now).written, 0, "unreadable is empty, never an error");

        note(t.path(), "Drafts/Ch_01.md", 100, 1000, now).unwrap();
        note(t.path(), "Drafts/Ch_01.md", 160, 1000, now + 1000).unwrap();
        assert_eq!(today(t.path(), 1000, now).written, 60, "the next write repairs the file");
    }

    #[test]
    fn unknown_keys_survive_a_round_trip() {
        // The format is proposed as a shared contract with the Swift app, so a
        // field this version has never heard of must not be dropped.
        let t = TempDir::new("sessions-unknown");
        let now = at(day(2026, 8, 31), 10);
        t.write(
            ".aquarius/sessions/2026-08-31.json",
            r#"{"date":"2026-08-31","goal":1000,"words":{"a.md":{"start":10,"latest":20,"minutes":45}},"mood":"good"}"#,
        );

        note(t.path(), "b.md", 5, 1000, now).unwrap();

        let raw = fs::read_to_string(t.path().join(".aquarius/sessions/2026-08-31.json")).unwrap();
        assert!(raw.contains("\"mood\""), "a day-level key we do not know was dropped: {raw}");
        assert!(raw.contains("\"minutes\""), "a document-level key was dropped: {raw}");
        assert_eq!(today(t.path(), 1000, now).written, 10, "and the real fields still parse");
    }

    #[test]
    fn the_sparkline_range_includes_the_empty_days() {
        let t = TempDir::new("sessions-range");
        let now = at(day(2026, 8, 31), 10);
        note(t.path(), "a.md", 0, 1000, at(day(2026, 8, 29), 10)).unwrap();
        note(t.path(), "a.md", 500, 1000, at(day(2026, 8, 29), 11)).unwrap();
        note(t.path(), "a.md", 500, 1000, now).unwrap();
        note(t.path(), "a.md", 700, 1000, now + 1000).unwrap();

        let days = range(t.path(), SPARK_DAYS, 1000, now);
        assert_eq!(days.len(), SPARK_DAYS);
        assert_eq!(days[SPARK_DAYS - 1].date, "2026-08-31", "the last entry is today");
        assert_eq!(days[SPARK_DAYS - 1].written, 200);
        assert_eq!(days[SPARK_DAYS - 3].written, 500, "two days back");
        assert_eq!(days[SPARK_DAYS - 2].written, 0, "the day between is present and empty");
    }

    #[test]
    fn a_streak_counts_back_from_today_or_yesterday_and_stops_at_the_first_gap() {
        let t = TempDir::new("sessions-streak");
        let now = at(day(2026, 8, 31), 10);
        let wrote = |d: NaiveDate| {
            note(t.path(), "a.md", 0, 1000, at(d, 10)).unwrap();
            note(t.path(), "a.md", 100, 1000, at(d, 11)).unwrap();
        };
        // 27th, 28th, 29th, 30th — then a gap on the 26th.
        for d in 27..=30 {
            wrote(day(2026, 8, d));
        }

        assert_eq!(streak(t.path(), 1000, now), 4, "nothing today yet, but yesterday holds it");

        wrote(day(2026, 8, 31));
        assert_eq!(streak(t.path(), 1000, now), 5, "today extends it");

        // A day with nothing written before yesterday ends the run.
        let quiet = at(day(2026, 9, 2), 10);
        assert_eq!(streak(t.path(), 1000, quiet), 0, "two silent days is not a streak");
    }

    #[test]
    fn a_renamed_document_keeps_the_words_it_was_written_under() {
        let t = TempDir::new("sessions-migrate-doc");
        let now = at(day(2026, 8, 31), 10);
        note(t.path(), "Drafts/Ch_03.md", 100, 1000, now).unwrap();
        note(t.path(), "Drafts/Ch_03.md", 500, 1000, now + 1000).unwrap();
        note(t.path(), "Drafts/Ch_03.md.bak", 10, 1000, now).unwrap();

        migrate_document(t.path(), "Drafts/Ch_03.md", "Drafts/Helmreach in Rain.md").unwrap();

        let summary = today(t.path(), 1000, now);
        assert_eq!(summary.written, 400, "the day's total is untouched by a rename");
        assert_eq!(summary.docs[0].path, "Drafts/Helmreach in Rain.md");
        let day = read_day(t.path(), &date_key(now));
        assert!(
            day.words.contains_key("Drafts/Ch_03.md.bak"),
            "only the exact key moves — a path that merely starts the same is left alone"
        );
    }

    #[test]
    fn a_moved_folder_takes_every_days_keys_with_it() {
        let t = TempDir::new("sessions-migrate-folder");
        let monday = at(day(2026, 8, 30), 10);
        let tuesday = at(day(2026, 8, 31), 10);
        for (path, when) in [("Drafts/Ch_01.md", monday), ("Drafts/Deep/Ch_02.md", tuesday)] {
            note(t.path(), path, 0, 1000, when).unwrap();
            note(t.path(), path, 300, 1000, when + 1000).unwrap();
        }
        note(t.path(), "Characters/Imogen.md", 0, 1000, tuesday).unwrap();
        note(t.path(), "Characters/Imogen.md", 50, 1000, tuesday + 1000).unwrap();

        migrate_folder(t.path(), "Drafts", "Archive/Drafts").unwrap();

        let monday_day = read_day(t.path(), &date_key(monday));
        assert!(monday_day.words.contains_key("Archive/Drafts/Ch_01.md"), "an older day migrated too");
        let tuesday_day = read_day(t.path(), &date_key(tuesday));
        assert!(tuesday_day.words.contains_key("Archive/Drafts/Deep/Ch_02.md"));
        assert!(
            tuesday_day.words.contains_key("Characters/Imogen.md"),
            "a key outside the moved folder is left alone"
        );
        assert_eq!(today(t.path(), 1000, tuesday).written, 350, "totals are unchanged");
    }

    #[test]
    fn the_goal_is_recorded_with_the_day_it_was_in_force_for() {
        let t = TempDir::new("sessions-goal");
        let now = at(day(2026, 8, 31), 10);
        note(t.path(), "a.md", 0, 800, now).unwrap();
        assert_eq!(today(t.path(), 1000, now).goal, 800, "the day's own goal wins");

        set_goal(t.path(), 1500, now).unwrap();
        assert_eq!(today(t.path(), 1000, now).goal, 1500);

        // A day that was never written to falls back to whatever is current.
        assert_eq!(range(t.path(), 3, 1234, now)[0].goal, 1234);
    }

    #[test]
    fn one_file_per_day_and_it_is_plain_readable_json() {
        let t = TempDir::new("sessions-shape");
        let now = at(day(2026, 8, 31), 10);
        note(t.path(), "Drafts/Ch_03.md", 2410, 1000, now).unwrap();

        let raw = fs::read_to_string(t.path().join(".aquarius/sessions/2026-08-31.json")).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["date"], "2026-08-31");
        assert_eq!(parsed["goal"], 1000);
        assert_eq!(parsed["words"]["Drafts/Ch_03.md"]["start"], 2410);
        assert_eq!(parsed["words"]["Drafts/Ch_03.md"]["latest"], 2410);
        assert!(parsed["updatedAt"].is_number());
    }
}
