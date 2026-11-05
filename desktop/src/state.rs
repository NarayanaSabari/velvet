use crate::api::{Comment, Issue, Milestone, Project, Sprint};

pub fn role_label(role: &str) -> &str {
    match role {
        "admin" => "Admin",
        "member" => "Member",
        "viewer" => "Viewer",
        _ => role,
    }
}

pub fn sprint_state_label(state: &str) -> &str {
    match state {
        "upcoming" => "Upcoming",
        "active" => "Active",
        "completed" => "Completed",
        _ => state,
    }
}

pub fn milestone_status_label(status: &str) -> &str {
    match status {
        "planned" => "Planned",
        "in_progress" => "In progress",
        "completed" => "Completed",
        "cancelled" => "Cancelled",
        _ => status,
    }
}

/// Done issues against every issue in the milestone, matching the web sprint board.
pub fn milestone_progress(milestone: &Milestone) -> (u32, u32) {
    let done = milestone.issue_counts.get("done").copied().unwrap_or(0);
    (done, milestone.issue_counts.values().sum())
}

/// Sprints in the project filter, keeping the server's newest-first order.
pub fn visible_sprints(sprints: &[Sprint], project: Option<&str>) -> Vec<usize> {
    sprints
        .iter()
        .enumerate()
        .filter(|(_, sprint)| project.is_none_or(|id| sprint.project_id == id))
        .map(|(index, _)| index)
        .collect()
}

/// Keeps the chosen sprint while it stays visible, otherwise opens the active one.
pub fn default_sprint(
    sprints: &[Sprint],
    project: Option<&str>,
    current: Option<&str>,
) -> Option<String> {
    let visible = visible_sprints(sprints, project);
    let pick = |wanted: &dyn Fn(&Sprint) -> bool| {
        visible
            .iter()
            .map(|&index| &sprints[index])
            .find(|sprint| wanted(sprint))
            .map(|sprint| sprint.id.clone())
    };
    pick(&|sprint| Some(sprint.id.as_str()) == current)
        .or_else(|| pick(&|sprint| sprint.state == "active"))
        .or_else(|| pick(&|_| true))
}

/// Filters hold a project id, but the API names a project by its key.
pub fn project_key(projects: &[Project], id: Option<&str>) -> Option<String> {
    let id = id?;
    projects.iter().find(|p| p.id == id).map(|p| p.key.clone())
}

/// Names the author and says when an agent, not the person, wrote the entry.
pub fn author_label(comment: &Comment) -> String {
    let name = comment.author.label();
    if comment.source == "agent" {
        format!("{name} (agent)")
    } else {
        name
    }
}

pub const STATUSES: [&str; 6] = [
    "backlog",
    "todo",
    "in_progress",
    "in_review",
    "done",
    "cancelled",
];

pub fn status_label(status: &str) -> &str {
    match status {
        "backlog" => "Backlog",
        "todo" => "Todo",
        "in_progress" => "In progress",
        "in_review" => "In review",
        "done" => "Done",
        "cancelled" => "Cancelled",
        _ => status,
    }
}

pub fn matching_indices(
    issues: &[Issue],
    query: &str,
    project: Option<&str>,
    status: Option<&str>,
) -> Vec<usize> {
    let query = query.trim().to_lowercase();
    issues
        .iter()
        .enumerate()
        .filter(|(_, issue)| {
            project.is_none_or(|id| issue.project_id.as_deref() == Some(id))
                && status.is_none_or(|status| issue.status == status)
                && (query.is_empty()
                    || [&issue.key, &issue.title, &issue.description]
                        .iter()
                        .any(|text| text.to_lowercase().contains(&query)))
        })
        .map(|(index, _)| index)
        .collect()
}

/// Each request captures a revision. Changing accounts or workspaces invalidates old replies.
#[derive(Default)]
pub struct Revision(u64);
impl Revision {
    pub fn next(&mut self) -> u64 {
        self.0 += 1;
        self.0
    }
    pub fn current(&self) -> u64 {
        self.0
    }
    pub fn accepts(&self, revision: u64) -> bool {
        self.0 == revision
    }
}

pub fn safe_external_url(value: &str) -> Option<String> {
    let url = url::Url::parse(value).ok()?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    Some(url.into())
}

/// Seconds since the Unix epoch for an RFC 3339 UTC timestamp such as
/// `2026-11-05T19:28:52Z` or with a fractional second. Offsets other than `Z`
/// are applied. Returns `None` for anything else.
// shortcut: no leap-second or calendar validation; swap for `time` if timestamps gain variety.
pub fn parse_rfc3339(value: &str) -> Option<i64> {
    let value = value.trim();
    if value.len() < 19 {
        return None;
    }
    let num = |s: &str| s.parse::<i64>().ok();
    let (y, m, d) = (num(&value[0..4])?, num(&value[5..7])?, num(&value[8..10])?);
    let (hh, mm, ss) = (
        num(&value[11..13])?,
        num(&value[14..16])?,
        num(&value[17..19])?,
    );
    let rest = &value[19..];
    let rest = rest.find(['Z', '+', '-']).map_or("", |i| &rest[i..]);
    let offset = match rest.as_bytes().first() {
        None | Some(b'Z') => 0,
        Some(sign) => {
            let sign = if *sign == b'-' { -1 } else { 1 };
            let (oh, om) = (num(rest.get(1..3)?)?, num(rest.get(4..6)?)?);
            sign * (oh * 3600 + om * 60)
        }
    };
    // Days from civil, Howard Hinnant's algorithm.
    let (y, m) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * m + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hh * 3600 + mm * 60 + ss - offset)
}

/// RFC 3339 UTC text for Unix seconds; the inverse of `parse_rfc3339`.
pub fn format_rfc3339(t: i64) -> String {
    let (days, secs) = (t.div_euclid(86_400), t.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        secs / 3600,
        secs % 3600 / 60,
        secs % 60
    )
}

/// Short age like `2d` or `3w` for list rows, from an RFC 3339 timestamp.
pub fn short_age(value: &str, now: i64) -> Option<String> {
    let seconds = (now - parse_rfc3339(value)?).max(0);
    Some(match seconds {
        s if s < 60 => "now".into(),
        s if s < 3600 => format!("{}m", s / 60),
        s if s < 86_400 => format!("{}h", s / 3600),
        s if s < 7 * 86_400 => format!("{}d", s / 86_400),
        s if s < 30 * 86_400 => format!("{}w", s / (7 * 86_400)),
        s if s < 365 * 86_400 => format!("{}mo", s / (30 * 86_400)),
        s => format!("{}y", s / (365 * 86_400)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_rfc3339_and_shortens_age() {
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339("2026-11-05T19:28:52Z"), Some(1_793_906_932));
        assert_eq!(
            parse_rfc3339("2026-11-05T19:28:52.123456+05:30"),
            Some(1_793_906_932 - 5 * 3600 - 30 * 60)
        );
        assert_eq!(parse_rfc3339(""), None);
        assert_eq!(format_rfc3339(1_793_906_932), "2026-11-05T19:28:52Z");
        assert_eq!(format_rfc3339(0), "1970-01-01T00:00:00Z");
        let now = 1_793_906_932;
        assert_eq!(
            short_age("2026-11-05T19:28:00Z", now).as_deref(),
            Some("now")
        );
        assert_eq!(
            short_age("2026-11-03T19:28:52Z", now).as_deref(),
            Some("2d")
        );
        assert_eq!(
            short_age("2026-10-20T19:28:52Z", now).as_deref(),
            Some("2w")
        );
        assert_eq!(short_age("bogus", now), None);
    }
    #[test]
    fn combines_search_project_and_status_without_hiding_identity() {
        let issues = vec![
            Issue {
                key: "VEL-1".into(),
                title: "Native shell".into(),
                status: "todo".into(),
                project_id: Some("one".into()),
                ..Default::default()
            },
            Issue {
                key: "VEL-2".into(),
                description: "native shell".into(),
                status: "done".into(),
                project_id: Some("two".into()),
                ..Default::default()
            },
        ];
        assert_eq!(
            matching_indices(&issues, " NATIVE ", Some("one"), Some("todo")),
            vec![0]
        );
        assert_eq!(matching_indices(&issues, "vel-2", None, None), vec![1]);
        assert!(matching_indices(&issues, "native", Some("two"), Some("todo")).is_empty());
        assert_eq!(matching_indices(&issues, "", None, None), vec![0, 1]);
    }
    #[test]
    fn sprints_follow_the_project_filter_and_open_the_active_one() {
        let sprint = |id: &str, project: &str, state: &str| Sprint {
            id: id.into(),
            project_id: project.into(),
            name: id.into(),
            starts_on: String::new(),
            ends_on: String::new(),
            state: state.into(),
        };
        let sprints = vec![
            sprint("next", "one", "upcoming"),
            sprint("now", "one", "active"),
            sprint("other", "two", "active"),
        ];
        assert_eq!(visible_sprints(&sprints, Some("one")), vec![0, 1]);
        assert_eq!(
            default_sprint(&sprints, Some("one"), None),
            Some("now".into())
        );
        assert_eq!(
            default_sprint(&sprints, Some("one"), Some("next")),
            Some("next".into())
        );
        // A choice hidden by the filter falls back to the visible active sprint.
        assert_eq!(
            default_sprint(&sprints, Some("two"), Some("next")),
            Some("other".into())
        );
        assert_eq!(default_sprint(&sprints, Some("none"), None), None);
    }
    #[test]
    fn milestone_progress_counts_every_status() {
        let milestone = Milestone {
            id: "m".into(),
            name: "Ship".into(),
            status: "in_progress".into(),
            target_date: None,
            issue_counts: [
                ("done".into(), 2),
                ("todo".into(), 1),
                ("cancelled".into(), 1),
            ]
            .into(),
        };
        assert_eq!(milestone_progress(&milestone), (2, 4));
        assert_eq!(milestone_status_label("in_progress"), "In progress");
    }
    #[test]
    fn new_issues_name_the_filtered_project_by_key() {
        let projects = vec![Project {
            id: "0b9f-uuid".into(),
            key: "desktop".into(),
            name: "Desktop".into(),
        }];
        assert_eq!(
            project_key(&projects, Some("0b9f-uuid")),
            Some("desktop".into())
        );
        assert_eq!(project_key(&projects, Some("missing")), None);
        assert_eq!(project_key(&projects, None), None);
    }
    #[test]
    fn author_falls_back_to_email_and_marks_agents() {
        let mut comment = Comment {
            author: crate::api::User {
                email: "person@example.com".into(),
                name: " ".into(),
            },
            body: String::new(),
            source: "human".into(),
            kind: None,
            deleted_at: None,
        };
        assert_eq!(author_label(&comment), "person@example.com");
        comment.author.name = "Ada".into();
        comment.source = "agent".into();
        assert_eq!(author_label(&comment), "Ada (agent)");
    }
    #[test]
    fn switching_context_rejects_late_responses() {
        let mut revision = Revision::default();
        let first = revision.next();
        assert!(revision.accepts(first));
        let second = revision.next();
        assert!(!revision.accepts(first));
        assert!(revision.accepts(second));
    }
    #[test]
    fn links_never_launch_scripts_or_local_files() {
        for url in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "velvet://token",
            "https://user:secret@host/",
        ] {
            assert!(safe_external_url(url).is_none());
        }
        assert_eq!(
            safe_external_url("https://github.com/"),
            Some("https://github.com/".into())
        );
    }
}
