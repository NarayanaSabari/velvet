//! Read-only native pages that used to open the web app.
//!
//! Each page is a few JSON reads turned into titled sections of rows. Pure
//! conversion keeps the GPUI view simple and lets tests cover every shape.
use crate::state::{milestone_status_label, status_label};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Page {
    Dashboard,
    Projects,
    Reports,
    Feed,
    Mentions,
    Unlinked,
    Worklog,
}

impl Page {
    pub fn title(self) -> &'static str {
        match self {
            Page::Dashboard => "Dashboard",
            Page::Projects => "Projects",
            Page::Reports => "Reports",
            Page::Feed => "Team feed",
            Page::Mentions => "Mentions",
            Page::Unlinked => "Unlinked PRs",
            Page::Worklog => "My work log",
        }
    }

    pub fn from_nav(path: &str) -> Option<Self> {
        Some(match path {
            "" => Page::Dashboard,
            "projects" => Page::Projects,
            "reports" => Page::Reports,
            "feed" => Page::Feed,
            "mentions" => Page::Mentions,
            "unlinked" => Page::Unlinked,
            "worklog" => Page::Worklog,
            _ => return None,
        })
    }

    /// API reads for this page: path segments after `/api/v1` plus query.
    /// `{slug}` is replaced with the current workspace.
    pub fn requests(
        self,
    ) -> &'static [(
        &'static [&'static str],
        &'static [(&'static str, &'static str)],
    )] {
        match self {
            Page::Dashboard => &[(&["w", "{slug}", "dashboard"], &[])],
            Page::Projects => &[(&["w", "{slug}", "projects"], &[])],
            Page::Reports => &[
                (&["w", "{slug}", "reports", "activity"], &[]),
                (&["w", "{slug}", "reports", "milestones"], &[]),
                (&["w", "{slug}", "reports", "closed"], &[]),
                (&["w", "{slug}", "reports", "stale"], &[]),
            ],
            Page::Feed => &[(&["w", "{slug}", "activity"], &[("limit", "100")])],
            Page::Mentions => &[(&["w", "{slug}", "mentions"], &[])],
            Page::Unlinked => &[(&["w", "{slug}", "pull-requests", "unlinked"], &[])],
            Page::Worklog => &[(&["me", "worklog"], &[("days", "30")])],
        }
    }

    pub fn build(self, responses: &[Value]) -> Vec<Section> {
        let r = |i: usize| responses.get(i).unwrap_or(&Value::Null);
        match self {
            Page::Dashboard => dashboard(r(0)),
            Page::Projects => projects(r(0)),
            Page::Reports => reports(r(0), r(1), r(2), r(3)),
            Page::Feed => vec![Section::new(
                "Recent activity",
                activity_rows(r(0).get("activity")),
            )],
            Page::Mentions => mentions(r(0)),
            Page::Unlinked => unlinked(r(0)),
            Page::Worklog => worklog(r(0)),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Row {
    pub title: String,
    pub detail: String,
    /// Opens the native issue view when present.
    pub issue_key: Option<String>,
    /// Opens in the default browser, for things that live elsewhere (GitHub).
    pub url: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Section {
    pub title: String,
    pub rows: Vec<Row>,
    pub empty: &'static str,
}

impl Section {
    fn new(title: impl Into<String>, rows: Vec<Row>) -> Self {
        Self {
            title: title.into(),
            rows,
            empty: "Nothing here yet.",
        }
    }
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn n(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(Value::as_i64).unwrap_or(0)
}
fn list(v: Option<&Value>) -> &[Value] {
    v.and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}
fn day(v: &str) -> &str {
    v.get(..10).unwrap_or(v)
}
fn user(v: Option<&Value>) -> String {
    let Some(v) = v.filter(|v| !v.is_null()) else {
        return "Velvet".into();
    };
    let name = s(v, "name").trim();
    if !name.is_empty() {
        return name.into();
    }
    match v.get("github_login").and_then(Value::as_str) {
        Some(login) if !login.is_empty() => login.into(),
        _ => s(v, "email").into(),
    }
}

fn issue_row(v: &Value) -> Row {
    Row {
        title: format!("{} {}", s(v, "key"), s(v, "title")),
        detail: status_label(s(v, "status")).into(),
        issue_key: Some(s(v, "key").to_owned()).filter(|k| !k.is_empty()),
        url: None,
    }
}

fn counts(v: &Value) -> (i64, i64) {
    let Some(map) = v.get("issue_counts").and_then(Value::as_object) else {
        return (0, 0);
    };
    let total: i64 = map.values().filter_map(Value::as_i64).sum();
    let done = map.get("done").and_then(Value::as_i64).unwrap_or(0);
    (done, total)
}

/// Phrases one activity event the way the web feed does.
pub fn describe_activity(a: &Value) -> String {
    let m = a.get("metadata").unwrap_or(&Value::Null);
    let key = s(m, "key");
    let target = if key.is_empty() { s(m, "name") } else { key };
    let what = match s(a, "verb") {
        "commented" => format!("commented on {target}"),
        "created_issue" => format!("created {key} {}", s(m, "title")),
        "changed_status" => format!(
            "moved {key} from {} to {}",
            status_label(s(m, "from")),
            status_label(s(m, "to"))
        ),
        "assigned" => format!(
            "assigned {key} to {}",
            m.get("assignee_login")
                .and_then(Value::as_str)
                .unwrap_or("someone")
        ),
        "attached_pr" => format!("attached PR #{} to {target}", n(m, "number")),
        "filed_entry" => format!("filed a note under {key}"),
        "completed_milestone" => format!("completed milestone {}", s(m, "name")),
        "closed_sprint" => format!("closed sprint {}", s(m, "name")),
        "invited_member" => format!("invited {} as {}", s(m, "email"), s(m, "role")),
        "changed_member_role" => {
            format!(
                "changed {} from {} to {}",
                s(m, "email"),
                s(m, "from"),
                s(m, "to")
            )
        }
        // Unknown verbs stay readable instead of failing the whole page.
        verb => format!("{} {target}", verb.replace('_', " ")),
    };
    format!("{} {}", user(a.get("actor")), what.trim())
}

fn activity_rows(v: Option<&Value>) -> Vec<Row> {
    list(v)
        .iter()
        .map(|a| {
            let key = a.get("metadata").map(|m| s(m, "key")).unwrap_or("");
            Row {
                title: describe_activity(a),
                detail: day(s(a, "created_at")).into(),
                issue_key: (a.get("target_type").and_then(Value::as_str) == Some("issue")
                    && !key.is_empty())
                .then(|| key.to_owned()),
                url: None,
            }
        })
        .collect()
}

fn dashboard(v: &Value) -> Vec<Section> {
    let unread = n(v, "unread_mentions");
    let mut sections = vec![Section {
        title: "Assigned to you".into(),
        rows: list(v.get("my_issues")).iter().map(issue_row).collect(),
        empty: "No open issues are assigned to you.",
    }];
    let mut sprint_rows = Vec::new();
    for active in list(v.get("active_sprints")) {
        let sprint = active.get("sprint").unwrap_or(&Value::Null);
        sprint_rows.push(Row {
            title: format!("{} · {}", s(active, "project_name"), s(sprint, "name")),
            detail: format!("{} to {}", s(sprint, "starts_on"), s(sprint, "ends_on")),
            ..Row::default()
        });
        for m in list(active.get("milestones")) {
            let (done, total) = counts(m);
            sprint_rows.push(Row {
                title: format!("    {}", s(m, "name")),
                detail: format!(
                    "{} · {done} of {total} done",
                    milestone_status_label(s(m, "status"))
                ),
                ..Row::default()
            });
        }
    }
    sections.push(Section {
        title: "Active sprints".into(),
        rows: sprint_rows,
        empty: "No sprint is running.",
    });
    sections.push(Section::new(
        format!(
            "Recent activity · {unread} unread mention{}",
            if unread == 1 { "" } else { "s" }
        ),
        activity_rows(v.get("activity")),
    ));
    sections
}

fn projects(v: &Value) -> Vec<Section> {
    let rows = list(v.get("projects"))
        .iter()
        .map(|p| {
            let (done, total) = counts(p);
            let description = s(p, "description").lines().next().unwrap_or("").to_owned();
            Row {
                title: format!("{} · {}", s(p, "key"), s(p, "name")),
                detail: [format!("{done} of {total} issues done"), description]
                    .into_iter()
                    .filter(|t| !t.is_empty())
                    .collect::<Vec<_>>()
                    .join(" · "),
                ..Row::default()
            }
        })
        .collect();
    vec![Section {
        title: "Projects".into(),
        rows,
        empty: "No projects yet.",
    }]
}

fn reports(activity: &Value, milestones: &Value, closed: &Value, stale: &Value) -> Vec<Section> {
    let people = list(activity.get("people"))
        .iter()
        .map(|p| {
            let name = if s(p, "name").is_empty() {
                s(p, "email")
            } else {
                s(p, "name")
            };
            let mut verbs: Vec<_> = p
                .get("verbs")
                .and_then(Value::as_object)
                .map(|m| {
                    m.iter()
                        .map(|(k, v)| (k.clone(), v.as_i64().unwrap_or(0)))
                        .collect()
                })
                .unwrap_or_default();
            verbs.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
            Row {
                title: format!("{name} · {} actions", n(p, "total")),
                detail: verbs
                    .iter()
                    .take(4)
                    .map(|(k, v)| format!("{} {v}", k.replace('_', " ")))
                    .collect::<Vec<_>>()
                    .join(" · "),
                ..Row::default()
            }
        })
        .collect();
    let sprint_rows = |v: &Value, done: &str, total: &str, noun: &str| -> Vec<Row> {
        list(v.get("sprints"))
            .iter()
            .map(|r| Row {
                title: format!("{} · {}", s(r, "project_name"), s(r, "sprint_name")),
                detail: format!(
                    "{} of {} {noun} · from {}",
                    n(r, done),
                    n(r, total),
                    s(r, "starts_on")
                ),
                ..Row::default()
            })
            .collect()
    };
    let days = n(stale, "days");
    let stale_rows = list(stale.get("issues"))
        .iter()
        .map(|i| {
            let who = if s(i, "assignee_name").is_empty() {
                s(i, "assignee_email")
            } else {
                s(i, "assignee_name")
            };
            Row {
                title: format!("{} {}", s(i, "key"), s(i, "title")),
                detail: format!(
                    "{} · silent {} days{}",
                    status_label(s(i, "status")),
                    n(i, "days_silent"),
                    if who.is_empty() {
                        String::new()
                    } else {
                        format!(" · {who}")
                    }
                ),
                issue_key: Some(s(i, "key").to_owned()).filter(|k| !k.is_empty()),
                url: None,
            }
        })
        .collect();
    vec![
        Section {
            title: "Activity per person".into(),
            rows: people,
            empty: "No activity recorded.",
        },
        Section {
            title: "Milestones completed per sprint".into(),
            rows: sprint_rows(milestones, "completed", "planned", "milestones completed"),
            empty: "No sprints yet.",
        },
        Section {
            title: "Issues closed per sprint".into(),
            rows: sprint_rows(closed, "closed", "total", "issues closed"),
            empty: "No sprints yet.",
        },
        Section {
            title: format!("Stale work · quiet for {days}+ days"),
            rows: stale_rows,
            empty: "Nothing has gone quiet.",
        },
    ]
}

fn mentions(v: &Value) -> Vec<Section> {
    let (mut unread, mut read) = (Vec::new(), Vec::new());
    for m in list(v.get("mentions")) {
        let c = m.get("comment").unwrap_or(&Value::Null);
        let label = s(m, "target_label");
        let key = label.split_whitespace().next().unwrap_or("");
        let row = Row {
            title: format!("{} on {label}", user(c.get("author"))),
            detail: format!(
                "{} · {}",
                day(s(c, "created_at")),
                s(c, "body").replace('\n', " ")
            ),
            issue_key: (s(c, "target_type") == "issue" && !key.is_empty()).then(|| key.to_owned()),
            url: None,
        };
        if m.get("read_at").is_none_or(Value::is_null) {
            unread.push(row)
        } else {
            read.push(row)
        }
    }
    vec![
        Section {
            title: "Unread".into(),
            rows: unread,
            empty: "You're all caught up.",
        },
        Section {
            title: "Earlier".into(),
            rows: read,
            empty: "No earlier mentions.",
        },
    ]
}

fn unlinked(v: &Value) -> Vec<Section> {
    let rows = list(v.get("pull_requests"))
        .iter()
        .map(|pr| {
            let suggestion = pr
                .get("suggestion")
                .filter(|s| !s.is_null())
                .map(|sg| format!(" · maybe {} {}", s(sg, "issue_key"), s(sg, "issue_title")))
                .unwrap_or_default();
            Row {
                title: format!("#{} {}", n(pr, "number"), s(pr, "title")),
                detail: format!("{} · {}{suggestion}", s(pr, "author_login"), s(pr, "state")),
                issue_key: None,
                url: crate::state::safe_external_url(s(pr, "html_url")),
            }
        })
        .collect();
    vec![Section {
        title: "Pull requests without an issue".into(),
        rows,
        empty: "Every pull request is linked.",
    }]
}

fn worklog(v: &Value) -> Vec<Section> {
    let mut sections: Vec<Section> = Vec::new();
    for e in list(v.get("entries")) {
        let d = s(e, "day").to_owned();
        if sections.last().is_none_or(|sec| sec.title != d) {
            sections.push(Section::new(d.clone(), Vec::new()));
        }
        let key = e.get("issue_key").and_then(Value::as_str).unwrap_or("");
        let project = e.get("project_key").and_then(Value::as_str).unwrap_or("");
        let body = s(e, "body").lines().next().unwrap_or("");
        sections.last_mut().unwrap().rows.push(Row {
            title: [key, s(e, "title")]
                .iter()
                .filter(|t| !t.is_empty())
                .copied()
                .collect::<Vec<_>>()
                .join(" "),
            detail: [s(e, "workspace_name"), project, s(e, "kind"), body]
                .iter()
                .filter(|t| !t.is_empty())
                .copied()
                .collect::<Vec<_>>()
                .join(" · "),
            issue_key: None,
            url: crate::state::safe_external_url(s(e, "url")),
        });
    }
    if sections.is_empty() {
        sections.push(Section {
            title: "Last 30 days".into(),
            rows: Vec::new(),
            empty: "No work logged in the last 30 days.",
        });
    }
    sections
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_nav_page_maps_and_has_requests() {
        for path in [
            "", "projects", "reports", "feed", "mentions", "unlinked", "worklog",
        ] {
            let page = Page::from_nav(path).unwrap();
            assert!(!page.requests().is_empty(), "{path}");
            // Empty payloads render empty sections, never panic.
            let empty = vec![Value::Null; page.requests().len()];
            assert!(!page.build(&empty).is_empty());
        }
        assert_eq!(Page::from_nav("issues"), None);
    }

    #[test]
    fn dashboard_lists_my_issues_sprints_and_activity() {
        let v = json!({
            "my_issues": [{"key":"ENG-1","title":"Fix login","status":"in_progress"}],
            "unread_mentions": 2,
            "active_sprints": [{"project_name":"Core","sprint":{"name":"Oct","starts_on":"2026-10-01","ends_on":"2026-10-31"},
                "milestones":[{"name":"Auth","status":"in_progress","issue_counts":{"done":1,"todo":3}}]}],
            "activity": [{"actor":{"name":"Ana"},"verb":"changed_status","target_type":"issue",
                "metadata":{"key":"ENG-1","from":"todo","to":"done"},"created_at":"2026-10-28T10:00:00Z"}]
        });
        let s = Page::Dashboard.build(&[v]);
        assert_eq!(s[0].rows[0].issue_key.as_deref(), Some("ENG-1"));
        assert_eq!(s[1].rows[1].detail, "In progress · 1 of 4 done");
        assert_eq!(s[2].title, "Recent activity · 2 unread mentions");
        assert_eq!(s[2].rows[0].title, "Ana moved ENG-1 from Todo to Done");
        assert_eq!(s[2].rows[0].detail, "2026-10-28");
    }

    #[test]
    fn activity_handles_unknown_verbs_and_missing_actor() {
        let a = json!({"actor":null,"verb":"invented_thing","metadata":{"key":"X-2"}});
        assert_eq!(describe_activity(&a), "Velvet invented thing X-2");
    }

    #[test]
    fn reports_mentions_unlinked_and_worklog_shapes() {
        let r = Page::Reports.build(&[
            json!({"people":[{"name":"","email":"a@x","total":5,"verbs":{"commented":3,"created_issue":2}}]}),
            json!({"sprints":[{"project_name":"Core","sprint_name":"Oct","planned":4,"completed":3,"starts_on":"2026-10-01"}]}),
            json!({"sprints":[]}),
            json!({"days":14,"issues":[{"key":"ENG-9","title":"Old","status":"todo","days_silent":20,"assignee_name":"Bo"}]}),
        ]);
        assert_eq!(r[0].rows[0].title, "a@x · 5 actions");
        assert_eq!(r[0].rows[0].detail, "commented 3 · created issue 2");
        assert_eq!(
            r[1].rows[0].detail,
            "3 of 4 milestones completed · from 2026-10-01"
        );
        assert!(r[2].rows.is_empty());
        assert_eq!(r[3].title, "Stale work · quiet for 14+ days");
        assert_eq!(r[3].rows[0].issue_key.as_deref(), Some("ENG-9"));

        let m = Page::Mentions.build(&[json!({"mentions":[
            {"read_at":null,"target_label":"ENG-3 Ship it","comment":{"target_type":"issue","author":{"name":"Ana"},"body":"hi @me","created_at":"2026-10-27T00:00:00Z"}},
            {"read_at":"2026-10-27","target_label":"Core","comment":{"target_type":"project","author":{"name":"Bo"},"body":"x","created_at":"2026-10-26T00:00:00Z"}}]})]);
        assert_eq!(m[0].rows[0].issue_key.as_deref(), Some("ENG-3"));
        assert_eq!(m[1].rows[0].issue_key, None);

        let u = Page::Unlinked.build(&[json!({"pull_requests":[{"number":42,"title":"Retry","author_login":"ana","state":"open",
            "html_url":"https://github.com/a/b/pull/42","suggestion":{"issue_key":"ENG-1","issue_title":"Fix"}}]})]);
        assert_eq!(u[0].rows[0].detail, "ana · open · maybe ENG-1 Fix");
        assert_eq!(
            u[0].rows[0].url.as_deref(),
            Some("https://github.com/a/b/pull/42")
        );

        let w = Page::Worklog.build(&[json!({"entries":[
            {"day":"2026-10-28","workspace_name":"Acme","kind":"comment","issue_key":"ENG-1","title":"Fix","body":"done\nmore"},
            {"day":"2026-10-28","workspace_name":"Acme","kind":"issue","title":"Other"},
            {"day":"2026-10-27","workspace_name":"Acme","kind":"issue","title":"Older","url":"javascript:alert(1)"}]})]);
        assert_eq!(w.len(), 2);
        assert_eq!(w[0].rows[0].title, "ENG-1 Fix");
        assert_eq!(w[0].rows[0].detail, "Acme · comment · done");
        assert_eq!(w[1].rows[0].url, None);
    }
}
