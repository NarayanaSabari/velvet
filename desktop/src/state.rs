use crate::api::{Comment, Issue, Milestone, Project, Sprint};

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

#[cfg(test)]
mod tests {
    use super::*;
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
