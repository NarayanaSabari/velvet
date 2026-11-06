use crate::{
    api::{
        ApiClient, Comment, DeviceSession, Evidence, Identity, Issue, Label, Member, Milestone,
        Project, Sprint,
    },
    credentials, pages,
    state::{self, Revision, STATUSES, author_label, status_label},
    theme::{self, Palette},
    update,
};
use gpui_kit::base::{FocusTrapElement, TestSupportExt, text::TextView};
use gpui_kit::component::kbd::Kbd;
use gpui_kit::component::menu::{DropdownMenu, PopupMenuItem};
use gpui_kit::component::{
    avatar::Avatar,
    button::{Button, ButtonVariants},
    input::{Input, InputEvent, InputState, Textarea, TextareaState},
    *,
};
// The full Lucide catalog; the component glob only re-exports a small subset.
use gpui_kit::assets::IconName as Lucide;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
#[cfg(all(test, feature = "ui-tests"))]
#[path = "ui_tests.rs"]
mod ui_tests;

use std::{
    collections::HashMap,
    rc::Rc,
    time::{Duration, Instant},
};

use crate::glass::{self, Glass, glass_region};

/// The test platform panics on `start_window_move`, so drag strips only move
/// a real window.
fn start_window_move(window: &mut Window) {
    if !cfg!(test) {
        window.start_window_move();
    }
}

const UPDATE_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
pub const DEFAULT_SERVER: &str = "https://velvet.sabarinarayana.com";

/// Sidebar destinations in web-shell order. The label always accompanies the icon.
const NAV: [(&str, &str, Lucide); 9] = [
    ("Dashboard", "", Lucide::LayoutDashboard),
    ("Issues", "issues", Lucide::ListTodo),
    ("Projects", "projects", Lucide::Folder),
    ("Sprints", "sprints", Lucide::IterationCw),
    ("Reports", "reports", Lucide::ChartColumn),
    ("Team feed", "feed", Lucide::Rss),
    ("Mentions", "mentions", Lucide::AtSign),
    ("Unlinked PRs", "unlinked", Lucide::GitPullRequest),
    ("My work log", "worklog", Lucide::NotebookPen),
];

#[derive(Clone, Copy)]
enum PaletteItem {
    Action(&'static str, Option<&'static str>, Lucide),
    Go(&'static str, &'static str, Lucide),
    Issue(usize),
}

impl PaletteItem {
    /// The text the palette shows and filters on, for non-issue rows.
    fn text(&self) -> String {
        match self {
            Self::Action(label, ..) => (*label).to_owned(),
            Self::Go(label, ..) => format!("Go to {label}"),
            Self::Issue(_) => String::new(),
        }
    }
}

/// A server write on the selected issue.
enum IssueMutation {
    Status(String),
    Assignee(Option<String>),
    Labels(Vec<String>),
}

impl IssueMutation {
    fn notice(&self) -> &'static str {
        match self {
            Self::Status(_) => "Status saved.",
            Self::Assignee(_) => "Assignee saved.",
            Self::Labels(_) => "Labels saved.",
        }
    }
}

/// Shape carries the status, so it reads without colour. Only Done gets a hue.
fn status_icon(status: &str, p: Palette) -> Icon {
    let (name, color) = match status {
        "backlog" => (Lucide::CircleDashed, p.muted),
        "todo" => (Lucide::Circle, p.secondary),
        "in_progress" => (Lucide::CircleDot, p.ink),
        "in_review" => (Lucide::CircleEllipsis, p.ink),
        "done" => (Lucide::CircleCheck, p.done),
        _ => (Lucide::CircleX, p.muted),
    };
    Icon::new(name).size(px(16.)).text_color(color)
}
actions!(
    velvet,
    [
        Quit,
        Commands,
        NewIssue,
        Refresh,
        NextIssue,
        PreviousIssue,
        Dismiss,
        PostUpdate,
        CheckForUpdates,
        ToggleAutoUpdate
    ]
);

pub struct Velvet {
    server: String,
    demo: bool,
    dark: bool,
    /// Liquid Glass chrome; false when macOS "Reduce transparency" is on.
    glass: bool,
    /// System `NSGlassEffectView` host (macOS 26+). None falls back to painted tints.
    native_glass: Option<Rc<Glass>>,
    focus: FocusHandle,
    modal_focus: FocusHandle,
    cancel_focus: FocusHandle,
    return_focus: Option<FocusHandle>,
    server_input: Entity<InputState>,
    search: Entity<InputState>,
    composer: Entity<TextareaState>,
    title: Entity<InputState>,
    description: Entity<TextareaState>,
    client: Option<ApiClient>,
    identity: Option<Identity>,
    workspace: usize,
    projects: Vec<Project>,
    members: Vec<Member>,
    /// Workspace label catalogue, for the native label picker.
    labels: Vec<Label>,
    project: Option<String>,
    status: Option<String>,
    /// Assignee filter: `None` for all, `Some(None)` for unassigned, `Some(Some(id))`.
    assignee: Option<Option<String>>,
    issues: Vec<Issue>,
    selected: Option<Issue>,
    comments: Vec<Comment>,
    evidence: Evidence,
    next_cursor: Option<String>,
    sprints_view: bool,
    sprints: Vec<Sprint>,
    sprint: Option<String>,
    milestones: Vec<Milestone>,
    milestone: Option<String>,
    /// Issues of the expanded milestone; `None` while they load.
    milestone_issues: Option<Vec<Issue>>,
    /// Native read-only page replacing the issue view, when set.
    page: Option<pages::Page>,
    page_sections: Vec<pages::Section>,
    page_loading: bool,
    page_revision: Revision,
    sprint_revision: Revision,
    milestone_revision: Revision,
    sprint_loading: bool,
    drafts: HashMap<(String, String), String>,
    form_drafts: HashMap<(String, Option<String>), (String, String)>,
    session_revision: Revision,
    list_revision: Revision,
    detail_revision: Revision,
    loading: bool,
    detail_loading: bool,
    saving: bool,
    error: Option<String>,
    notice: Option<String>,
    login: Option<DeviceSession>,
    commands: bool,
    /// Command palette query and highlighted result.
    palette: Entity<InputState>,
    palette_index: usize,
    editing: bool,
    edit_key: Option<String>,
    confirm_logout: bool,
    quit_prompt: bool,
    quitting: bool,
    /// Verified newer release, offered in a banner.
    available_update: Option<update::Manifest>,
    /// Verified bundle waiting to replace this one at Quit.
    staged_update: Option<std::path::PathBuf>,
    auto_update: bool,
    relaunch: bool,
    updating: bool,
    _subscriptions: Vec<Subscription>,
}

impl Velvet {
    fn palette(&self) -> Palette {
        let p = Palette::new(self.dark);
        if self.glass { p } else { p.opaque() }
    }
    /// Backs `el` with a native glass view when available, else paints `fill`.
    fn glass_backed(
        &self,
        el: Div,
        name: &'static str,
        radius: Pixels,
        clear: bool,
        fill: Hsla,
    ) -> Div {
        match &self.native_glass {
            Some(g) if self.glass => el.relative().child(glass_region(g, name, radius, clear)),
            _ => el.bg(fill),
        }
    }
    /// Near-opaque content panel floating over the glass backdrop.
    fn card<E: Styled>(&self, p: Palette, el: E) -> E {
        el.rounded(px(14.))
            .overflow_hidden()
            .bg(p.card)
            .border_t_1()
            .border_color(p.edge)
    }
    pub fn new(server: String, demo: bool, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let dark = matches!(
            window.appearance(),
            WindowAppearance::Dark | WindowAppearance::VibrantDark
        );
        theme::apply(dark, cx);
        let server_input =
            cx.new(|cx| InputState::new(window, cx).placeholder("https://your-velvet-server"));
        server_input.update(cx, |s, cx| s.set_value(server.clone(), window, cx));
        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Search loaded issues…"));
        let palette =
            cx.new(|cx| InputState::new(window, cx).placeholder("Type a command or issue…"));
        let composer = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder("Write an update…")
                .rows(3)
        });
        let title = cx.new(|cx| InputState::new(window, cx).placeholder("Issue title"));
        let description = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder("Description (Markdown)")
                .rows(6)
        });
        let subscriptions = vec![
            cx.subscribe(&search, |_, _, _: &InputEvent, cx| cx.notify()),
            cx.subscribe(&palette, |this, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    this.palette_index = 0;
                    cx.notify();
                }
            }),
            cx.subscribe(&composer, |this, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    if let (Some(slug), Some(issue)) = (this.slug(), this.selected.as_ref()) {
                        this.drafts.insert(
                            (slug, issue.key.clone()),
                            this.composer.read(cx).value().to_string(),
                        );
                    }
                }
            }),
            window.observe_window_appearance(|window, cx| {
                theme::apply(
                    matches!(
                        window.appearance(),
                        WindowAppearance::Dark | WindowAppearance::VibrantDark
                    ),
                    cx,
                );
                cx.refresh_windows();
            }),
        ];
        let glass = !Palette::reduce_transparency();
        let native_glass = (glass && glass::available()).then(|| Rc::new(Glass::new()));
        if native_glass.is_some() {
            // gpui's own NSVisualEffectView would sit between the glass views
            // and the desktop and flatten them; use a plain transparent window.
            window.set_background_appearance(WindowBackgroundAppearance::Transparent);
        }
        let mut this = Self {
            server,
            demo,
            dark,
            glass,
            native_glass,
            focus: cx.focus_handle(),
            modal_focus: cx.focus_handle(),
            cancel_focus: cx.focus_handle(),
            return_focus: None,
            server_input,
            search,
            composer,
            title,
            description,
            client: None,
            identity: None,
            workspace: 0,
            projects: vec![],
            members: vec![],
            labels: vec![],
            project: None,
            status: None,
            assignee: None,
            issues: vec![],
            selected: None,
            comments: vec![],
            evidence: Evidence::default(),
            next_cursor: None,
            sprints_view: false,
            sprints: vec![],
            sprint: None,
            milestones: vec![],
            milestone: None,
            milestone_issues: None,
            page: None,
            page_sections: Vec::new(),
            page_loading: false,
            page_revision: Revision::default(),
            sprint_revision: Revision::default(),
            milestone_revision: Revision::default(),
            sprint_loading: false,
            drafts: HashMap::new(),
            form_drafts: HashMap::new(),
            session_revision: Revision::default(),
            list_revision: Revision::default(),
            detail_revision: Revision::default(),
            loading: false,
            detail_loading: false,
            saving: false,
            error: None,
            notice: None,
            login: None,
            commands: false,
            palette,
            palette_index: 0,
            editing: false,
            edit_key: None,
            confirm_logout: false,
            quit_prompt: false,
            quitting: false,
            available_update: None,
            staged_update: None,
            auto_update: update::auto_update_enabled(),
            relaunch: false,
            updating: false,
            _subscriptions: subscriptions,
        };
        if demo {
            this.seed_demo();
        } else {
            this.restore(cx);
        }
        // Only packaged apps can replace themselves, so dev runs skip the check.
        if let Some(target) = update::running_bundle() {
            this.show_update_recovery(update::previous_failure(&target));
            cx.spawn(async move |view, cx| {
                loop {
                    if view
                        .update(cx, |this, cx| this.check_for_updates(false, cx))
                        .is_err()
                    {
                        break;
                    }
                    smol::Timer::after(UPDATE_INTERVAL).await;
                }
            })
            .detach();
        }
        this
    }

    fn show_update_recovery(&mut self, result: anyhow::Result<Option<String>>) {
        // Recovery survives request refreshes, which intentionally clear request errors.
        match result {
            Ok(Some(message)) => self.notice = Some(message),
            Err(error) => {
                self.notice = Some(format!("Could not read update recovery status: {error}"))
            }
            Ok(None) => {}
        }
    }

    pub fn check_for_updates(&mut self, manual: bool, cx: &mut Context<Self>) {
        if self.updating || self.staged_update.is_some() {
            if manual {
                self.notice = Some("An update is ready. Restart Velvet to finish.".into());
                cx.notify();
            }
            return;
        }
        cx.spawn(async move |view, cx| {
            let result = smol::unblock(update::check).await;
            let _ = view.update(cx, |this, cx| {
                match result {
                    Ok(Some(manifest)) => {
                        this.available_update = Some(manifest);
                        if this.auto_update {
                            this.download_update(cx);
                        }
                    }
                    Ok(None) if manual => {
                        this.notice =
                            Some(format!("Velvet {} is the latest version.", update::CURRENT))
                    }
                    // Background checks stay silent offline.
                    Err(error) if manual => this.error = Some(error.to_string()),
                    _ => {}
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// Download and verify in the background. The swap waits for Quit.
    fn download_update(&mut self, cx: &mut Context<Self>) {
        let Some(manifest) = self.available_update.clone() else {
            return;
        };
        let Some(target) = update::running_bundle() else {
            self.error = Some("Updates install only into a packaged Velvet app.".into());
            cx.notify();
            return;
        };
        if self.updating {
            return;
        }
        self.updating = true;
        cx.notify();
        cx.spawn(async move |view, cx| {
            let result = smol::unblock(move || {
                update::check_writable(&target)?;
                update::download(&manifest)
            })
            .await;
            let _ = view.update(cx, |this, cx| {
                this.updating = false;
                match result {
                    Ok(staged) => this.staged_update = Some(staged),
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn restart_to_update(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.relaunch = true;
        self.request_quit(window, cx);
    }

    /// Every quit path prepares a staged update before permitting exit.
    fn finish_quit(&mut self, cx: &mut Context<Self>) {
        if let Some(staged) = &self.staged_update {
            let result = update::running_bundle()
                .ok_or_else(|| anyhow::anyhow!("Could not locate the installed Velvet app."))
                .and_then(|target| update::install_on_exit(staged, &target, self.relaunch));
            if let Err(error) = result {
                self.error = Some(format!("Update could not start: {error}"));
                self.quit_prompt = false;
                self.relaunch = false;
                // Allow a later download or a normal quit instead of trapping the user.
                self.staged_update = None;
                cx.notify();
                return;
            }
        }
        self.quitting = true;
        cx.quit();
    }

    fn toggle_auto_update(&mut self, cx: &mut Context<Self>) {
        let enabled = !self.auto_update;
        match update::set_auto_update(enabled) {
            Ok(()) => {
                self.auto_update = enabled;
                if enabled && self.available_update.is_some() {
                    self.download_update(cx);
                }
            }
            Err(error) => self.error = Some(error.to_string()),
        }
        cx.notify();
    }

    pub fn is_quitting(&self) -> bool {
        self.quitting
    }
    /// True when system `NSGlassEffectView`s back the chrome.
    pub fn native_glass(&self) -> bool {
        self.native_glass.is_some()
    }

    pub fn request_quit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.quitting {
            return;
        }
        if self.saving || self.quit_prompt {
            self.error = Some("Wait for the current operation before quitting.".into());
            cx.notify();
            return;
        }
        let dirty = self.drafts.values().any(|draft| !draft.trim().is_empty())
            || self
                .form_drafts
                .values()
                .any(|(title, body)| !title.trim().is_empty() || !body.trim().is_empty())
            || (self.editing
                && (!self.title.read(cx).value().trim().is_empty()
                    || !self.description.read(cx).value().trim().is_empty()));
        if !dirty {
            self.finish_quit(cx);
            return;
        }
        self.quit_prompt = true;
        window.focus(&self.cancel_focus, cx);
        cx.notify();
    }
    fn slug(&self) -> Option<String> {
        self.identity
            .as_ref()?
            .memberships
            .get(self.workspace)
            .map(|m| m.workspace_slug.clone())
    }
    fn can_write(&self) -> bool {
        self.identity
            .as_ref()
            .and_then(|i| i.memberships.get(self.workspace))
            .is_some_and(|m| matches!(m.role.as_str(), "admin" | "member"))
    }
    fn restore(&mut self, cx: &mut Context<Self>) {
        self.loading = true;
        let server = self.server.clone();
        let revision = self.session_revision.next();
        cx.spawn(async move |view, cx| {
            let result = smol::unblock(move || -> anyhow::Result<_> {
                let Some(token) = credentials::load(&server)? else {
                    return Ok(None);
                };
                let client = ApiClient::new(&server, Some(token))?;
                let identity = client.identity()?;
                Ok(Some((client, identity)))
            })
            .await;
            let _ = view.update(cx, |this, cx| {
                if !this.session_revision.accepts(revision) {
                    return;
                }
                this.loading = false;
                match result {
                    Ok(Some((client, identity))) => {
                        this.client = Some(client);
                        this.identity = Some(identity);
                        this.refresh(false, cx);
                    }
                    Ok(None) => {}
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn sign_in(&mut self, cx: &mut Context<Self>) {
        if self.loading {
            return;
        }
        let server = self.server_input.read(cx).value().to_string();
        let server = match crate::api::normalize_server(&server) {
            Ok(s) => s,
            Err(e) => {
                self.error = Some(e.to_string());
                cx.notify();
                return;
            }
        };
        self.server = server.clone();
        self.loading = true;
        self.error = None;
        let revision = self.session_revision.next();
        cx.spawn(async move |view, cx| {
            let result = smol::unblock(move || {
                let client = ApiClient::new(&server, None)?;
                let session = client.start_login()?;
                Ok::<_, anyhow::Error>((client, session))
            })
            .await;
            let Ok(Some((client, session))) = view.update(cx, |this, cx| {
                if !this.session_revision.accepts(revision) {
                    return None;
                }
                match result {
                    Ok((client, session)) => {
                        // Open only this server's consent page, never an arbitrary server-supplied URL.
                        let code =
                            url::form_urlencoded::byte_serialize(session.user_code.as_bytes())
                                .collect::<String>();
                        cx.open_url(&format!("{}/cli/approve?code={code}", this.server));
                        this.login = Some(session.clone());
                        cx.notify();
                        Some((client, session))
                    }
                    Err(e) => {
                        this.loading = false;
                        this.error = Some(e.to_string());
                        cx.notify();
                        None
                    }
                }
            }) else {
                return;
            };
            // Sessions expire server-side. A local ten-minute bound also stops abandoned polling.
            let deadline = Instant::now() + Duration::from_secs(600);
            while Instant::now() < deadline {
                smol::Timer::after(Duration::from_secs(session.interval.clamp(2, 10))).await;
                if !view
                    .update(cx, |this, _| this.session_revision.accepts(revision))
                    .unwrap_or(false)
                {
                    return;
                }
                let poll_client = client.clone();
                let code = session.device_code.clone();
                let result = smol::unblock(move || poll_client.poll_login(&code)).await;
                match result {
                    Ok(None) => continue,
                    Ok(Some(grant)) => {
                        let server = client.server().to_owned();
                        let current = view
                            .update(cx, |this, cx| {
                                if !this.session_revision.accepts(revision) {
                                    return false;
                                }
                                // Finish credential persistence atomically with respect to UI cancellation.
                                this.saving = true;
                                cx.notify();
                                true
                            })
                            .unwrap_or(false);
                        if !current {
                            smol::unblock(move || {
                                if let Ok(client) = ApiClient::new(&server, Some(grant.token)) {
                                    let _ = client.revoke();
                                }
                            })
                            .await;
                            return;
                        }
                        let result = smol::unblock(move || -> anyhow::Result<_> {
                            let client = ApiClient::new(&server, Some(grant.token.clone()))?;
                            let identity = match client.identity() {
                                Ok(identity) => identity,
                                Err(error) => {
                                    let _ = client.revoke();
                                    return Err(error);
                                }
                            };
                            if let Err(error) = credentials::save(&server, &grant.token) {
                                let _ = client.revoke();
                                return Err(error);
                            }
                            Ok((client, identity))
                        })
                        .await;
                        let _ = view.update(cx, |this, cx| {
                            if !this.session_revision.accepts(revision) {
                                return;
                            }
                            this.loading = false;
                            this.saving = false;
                            this.login = None;
                            match result {
                                Ok((client, identity)) => {
                                    this.client = Some(client);
                                    this.identity = Some(identity);
                                    this.refresh(false, cx);
                                }
                                Err(e) => this.error = Some(e.to_string()),
                            }
                            cx.notify();
                        });
                        return;
                    }
                    Err(e) => {
                        let _ = view.update(cx, |this, cx| {
                            if this.session_revision.accepts(revision) {
                                this.loading = false;
                                this.login = None;
                                this.error = Some(e.to_string());
                                cx.notify();
                            }
                        });
                        return;
                    }
                }
            }
            let _ = view.update(cx, |this, cx| {
                if this.session_revision.accepts(revision) {
                    this.loading = false;
                    this.login = None;
                    this.error = Some("Sign-in expired. Start again.".into());
                    cx.notify();
                }
            });
        })
        .detach();
    }
    fn refresh(&mut self, more: bool, cx: &mut Context<Self>) {
        if self.saving {
            return;
        }
        if self.demo {
            self.notice = Some("Sample data. No server requests are sent.".into());
            cx.notify();
            return;
        }
        let (Some(client), Some(slug)) = (self.client.clone(), self.slug()) else {
            return;
        };
        if self.sprints_view && !more {
            self.load_sprints(cx);
        }
        let cursor = if more { self.next_cursor.clone() } else { None };
        let session = self.session_revision.current();
        let revision = self.list_revision.next();
        self.loading = true;
        self.error = None;
        cx.spawn(async move |view, cx| {
            let result = smol::unblock(move || -> anyhow::Result<_> {
                // Independent requests run concurrently so one round trip, not two,
                // bounds the refresh.
                let (boot, page) = std::thread::scope(|s| {
                    let boot = s.spawn(|| client.bootstrap(&slug));
                    let page = s.spawn(|| client.issues_page(&slug, None, None, cursor.as_deref()));
                    (boot.join().unwrap(), page.join().unwrap())
                });
                let boot = boot?;
                Ok((boot.projects, boot.members, boot.labels, page?))
            })
            .await;
            let _ = view.update(cx, |this, cx| {
                if !this.session_revision.accepts(session) || !this.list_revision.accepts(revision)
                {
                    return;
                }
                this.loading = false;
                match result {
                    Ok((projects, members, labels, page)) => {
                        this.projects = projects;
                        this.members = members;
                        this.labels = labels;
                        this.next_cursor = page.next_cursor;
                        if more {
                            for issue in page.issues {
                                if !this.issues.iter().any(|i| i.id == issue.id) {
                                    this.issues.push(issue);
                                }
                            }
                        } else {
                            this.issues = page.issues;
                        }
                    }
                    Err(e) => this.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn select_issue(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(issue) = self.issues.get(index).cloned() else {
            return;
        };
        if self.saving {
            return;
        }
        let Some(slug) = self.slug() else {
            return;
        };
        let draft = self
            .drafts
            .get(&(slug.clone(), issue.key.clone()))
            .cloned()
            .unwrap_or_default();
        self.selected = Some(issue.clone());
        self.composer
            .update(cx, |s, cx| s.set_value(draft, window, cx));
        self.comments.clear();
        self.evidence = Evidence::default();
        self.error = None;
        let revision = self.detail_revision.next();
        let session = self.session_revision.current();
        if self.demo {
            cx.notify();
            return;
        }
        let Some(client) = self.client.clone() else {
            return;
        };
        self.detail_loading = true;
        cx.spawn(async move |view, cx| {
            let result = smol::unblock(move || -> anyhow::Result<_> {
                let (detail, comments, evidence) = std::thread::scope(|s| {
                    let detail = s.spawn(|| client.issue(&slug, &issue.key));
                    let comments = s.spawn(|| client.comments(&slug, &issue.key));
                    // Evidence is optional context; a failure must not hide the issue.
                    let evidence =
                        s.spawn(|| client.evidence(&slug, &issue.key).unwrap_or_default());
                    (
                        detail.join().unwrap(),
                        comments.join().unwrap(),
                        evidence.join().unwrap(),
                    )
                });
                Ok((detail?, comments?, evidence))
            })
            .await;
            let _ = view.update(cx, |this, cx| {
                if !this.session_revision.accepts(session)
                    || !this.detail_revision.accepts(revision)
                {
                    return;
                }
                this.detail_loading = false;
                match result {
                    Ok((issue, comments, evidence)) => {
                        this.selected = Some(issue);
                        this.comments = comments;
                        this.evidence = evidence;
                    }
                    Err(e) => this.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn clear_sprints(&mut self) {
        self.sprint_revision.next();
        self.milestone_revision.next();
        self.sprints.clear();
        self.sprint = None;
        self.milestones.clear();
        self.milestone = None;
        self.milestone_issues = None;
        self.sprint_loading = false;
        // Native pages belong to the workspace too, so every reset drops them.
        self.page_revision.next();
        self.page = None;
        self.page_sections.clear();
        self.page_loading = false;
    }
    fn show_page(&mut self, page: pages::Page, cx: &mut Context<Self>) {
        self.commands = false;
        self.sprints_view = false;
        self.page = Some(page);
        self.page_sections.clear();
        self.error = None;
        let revision = self.page_revision.next();
        if self.demo {
            self.page_sections = page.build(&[]);
            cx.notify();
            return;
        }
        let (Some(client), Some(slug)) = (self.client.clone(), self.slug()) else {
            return;
        };
        let session = self.session_revision.current();
        self.page_loading = true;
        cx.notify();
        cx.spawn(async move |view, cx| {
            let result = smol::unblock(move || -> anyhow::Result<Vec<serde_json::Value>> {
                page.requests()
                    .iter()
                    .map(|(segments, query)| {
                        let segments: Vec<&str> = segments
                            .iter()
                            .map(|s| if *s == "{slug}" { slug.as_str() } else { s })
                            .collect();
                        client.get_json(&segments, query)
                    })
                    .collect()
            })
            .await;
            let _ = view.update(cx, |this, cx| {
                if !this.session_revision.accepts(session) || !this.page_revision.accepts(revision)
                {
                    return;
                }
                this.page_loading = false;
                match result {
                    Ok(responses) => this.page_sections = page.build(&responses),
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }
    /// Opens an issue named on a native page, fetching it when not yet loaded.
    fn open_issue_key(&mut self, key: String, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(issue) = self.issues.iter().find(|i| i.key == key).cloned() {
            self.page = None;
            self.open_issue(issue, window, cx);
            return;
        }
        let (Some(client), Some(slug)) = (self.client.clone(), self.slug()) else {
            return;
        };
        let session = self.session_revision.current();
        let handle = window.window_handle();
        cx.spawn(async move |view, cx| {
            let result = smol::unblock(move || client.issue(&slug, &key)).await;
            let _ = handle.update(cx, |_, window, cx| {
                let _ = view.update(cx, |this, cx| {
                    if !this.session_revision.accepts(session) {
                        return;
                    }
                    match result {
                        Ok(issue) => {
                            this.page = None;
                            this.open_issue(issue, window, cx);
                        }
                        Err(error) => this.error = Some(error.to_string()),
                    }
                    cx.notify();
                });
            });
        })
        .detach();
    }
    fn show_sprints(&mut self, cx: &mut Context<Self>) {
        self.page = None;
        self.commands = false;
        self.sprints_view = true;
        if self.sprints.is_empty() {
            self.load_sprints(cx);
        }
        cx.notify();
    }
    fn load_sprints(&mut self, cx: &mut Context<Self>) {
        if self.demo {
            return;
        }
        let (Some(client), Some(slug)) = (self.client.clone(), self.slug()) else {
            return;
        };
        let session = self.session_revision.current();
        let revision = self.sprint_revision.next();
        self.sprint_loading = true;
        cx.spawn(async move |view, cx| {
            let result = smol::unblock(move || client.sprints(&slug)).await;
            let _ = view.update(cx, |this, cx| {
                if !this.session_revision.accepts(session)
                    || !this.sprint_revision.accepts(revision)
                {
                    return;
                }
                this.sprint_loading = false;
                match result {
                    Ok(sprints) => {
                        this.sprints = sprints;
                        let next = state::default_sprint(
                            &this.sprints,
                            this.project.as_deref(),
                            this.sprint.as_deref(),
                        );
                        this.select_sprint(next, cx);
                    }
                    Err(e) => this.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn select_sprint(&mut self, id: Option<String>, cx: &mut Context<Self>) {
        self.milestone_revision.next();
        self.milestone = None;
        self.milestone_issues = None;
        self.sprint = id.clone();
        cx.notify();
        // The sample workspace has one sprint whose milestones are already seeded.
        if self.demo {
            return;
        }
        self.milestones.clear();
        let (Some(id), Some(client), Some(slug)) = (id, self.client.clone(), self.slug()) else {
            return;
        };
        let session = self.session_revision.current();
        let revision = self.sprint_revision.next();
        self.sprint_loading = true;
        cx.spawn(async move |view, cx| {
            let result = smol::unblock(move || client.milestones(&slug, &id)).await;
            let _ = view.update(cx, |this, cx| {
                if !this.session_revision.accepts(session)
                    || !this.sprint_revision.accepts(revision)
                {
                    return;
                }
                this.sprint_loading = false;
                match result {
                    Ok(milestones) => this.milestones = milestones,
                    Err(e) => this.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn toggle_milestone(&mut self, id: String, cx: &mut Context<Self>) {
        let revision = self.milestone_revision.next();
        self.milestone_issues = None;
        cx.notify();
        if self.milestone.as_deref() == Some(id.as_str()) {
            self.milestone = None;
            return;
        }
        self.milestone = Some(id.clone());
        if self.demo {
            let issues = self
                .issues
                .iter()
                .filter(|i| i.milestone_id.as_ref() == Some(&id));
            self.milestone_issues = Some(issues.cloned().collect());
            return;
        }
        let (Some(client), Some(slug)) = (self.client.clone(), self.slug()) else {
            return;
        };
        let session = self.session_revision.current();
        cx.spawn(async move |view, cx| {
            let result = smol::unblock(move || client.milestone_issues(&slug, &id)).await;
            let _ = view.update(cx, |this, cx| {
                if !this.session_revision.accepts(session)
                    || !this.milestone_revision.accepts(revision)
                {
                    return;
                }
                match result {
                    Ok(issues) => this.milestone_issues = Some(issues),
                    Err(e) => {
                        this.milestone = None;
                        this.error = Some(e.to_string());
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }
    /// Opens a sprint issue in the native detail, even if it is not in the loaded page.
    fn open_issue(&mut self, issue: Issue, window: &mut Window, cx: &mut Context<Self>) {
        if self.saving {
            return;
        }
        self.sprints_view = false;
        self.page = None;
        let index = match self.issues.iter().position(|i| i.id == issue.id) {
            Some(index) => index,
            None => {
                self.issues.push(issue);
                self.issues.len() - 1
            }
        };
        self.select_issue(index, window, cx);
    }
    fn switch_workspace(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        if self.saving || self.editing {
            self.error =
                Some("Finish or cancel the issue form before switching organisations.".into());
            cx.notify();
            return;
        }
        let Some(identity) = &self.identity else {
            return;
        };
        if index >= identity.memberships.len() || index == self.workspace {
            return;
        }
        self.workspace = index;
        self.session_revision.next();
        self.detail_revision.next();
        self.list_revision.next();
        self.project = None;
        self.status = None;
        self.issues.clear();
        self.projects.clear();
        self.members.clear();
        self.labels.clear();
        self.assignee = None;
        self.selected = None;
        self.comments.clear();
        self.evidence = Evidence::default();
        self.next_cursor = None;
        self.detail_loading = false;
        self.clear_sprints();
        self.search.update(cx, |s, cx| s.set_value("", window, cx));
        self.composer
            .update(cx, |s, cx| s.set_value("", window, cx));
        self.refresh(false, cx);
    }
    fn open_form(&mut self, edit: bool, window: &mut Window, cx: &mut Context<Self>) {
        if !self.can_write()
            || self.saving
            || self.editing
            || self.confirm_logout
            || self.quit_prompt
        {
            return;
        }
        let Some(slug) = self.slug() else {
            return;
        };
        let issue = if edit { self.selected.clone() } else { None };
        // List rows omit the description (fields=summary); editing before the
        // detail arrives would blank it on save.
        if edit && (issue.is_none() || (self.detail_loading && !self.demo)) {
            return;
        }
        self.return_focus = window.focused(cx);
        self.commands = false;
        self.editing = true;
        self.edit_key = issue.as_ref().map(|issue| issue.key.clone());
        let (title, description) = self
            .form_drafts
            .get(&(slug, self.edit_key.clone()))
            .cloned()
            .unwrap_or_else(|| {
                issue
                    .map(|issue| (issue.title, issue.description))
                    .unwrap_or_default()
            });
        self.title
            .update(cx, |s, cx| s.set_value(title, window, cx));
        self.description
            .update(cx, |s, cx| s.set_value(description, window, cx));
        self.title.update(cx, |s, cx| s.focus(window, cx));
        cx.notify();
    }
    fn close_overlay(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.saving {
            return;
        }
        if self.quit_prompt {
            self.quit_prompt = false;
            self.relaunch = false;
            if self.editing {
                self.title.update(cx, |input, cx| input.focus(window, cx));
            } else {
                window.focus(&self.focus, cx);
            }
            cx.notify();
            return;
        }
        if self.editing {
            if let Some(slug) = self.slug() {
                self.form_drafts.insert(
                    (slug, self.edit_key.clone()),
                    (
                        self.title.read(cx).value().to_string(),
                        self.description.read(cx).value().to_string(),
                    ),
                );
            }
        }
        self.commands = false;
        self.editing = false;
        self.confirm_logout = false;
        self.quit_prompt = false;
        window.focus(self.return_focus.as_ref().unwrap_or(&self.focus), cx);
        cx.notify();
    }
    fn open_commands(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.editing || self.confirm_logout || self.quit_prompt || self.saving {
            return;
        }
        if self.commands {
            self.close_overlay(window, cx);
            return;
        }
        self.return_focus = window.focused(cx);
        self.commands = true;
        self.palette_index = 0;
        self.palette.update(cx, |s, cx| {
            s.set_value("", window, cx);
            s.focus(window, cx);
        });
        cx.notify();
    }
    /// Commands, destinations, then loaded issues matching the palette query.
    fn palette_items(&self, cx: &App) -> Vec<PaletteItem> {
        let query = self.palette.read(cx).value().to_lowercase();
        let query = query.trim();
        let mut items = vec![
            PaletteItem::Action("New issue", Some("cmd-n"), Lucide::SquarePen),
            PaletteItem::Action("Refresh issues", Some("cmd-r"), Lucide::RefreshCw),
            PaletteItem::Action("Search issues", None, Lucide::Search),
            PaletteItem::Action("Toggle appearance", None, Lucide::Moon),
        ];
        items.extend(
            NAV.iter()
                .map(|(label, path, icon)| PaletteItem::Go(label, path, *icon)),
        );
        items.retain(|item| item.text().to_lowercase().contains(query));
        if !query.is_empty() {
            items.extend(
                self.issues
                    .iter()
                    .enumerate()
                    .filter(|(_, i)| {
                        i.key.to_lowercase().contains(query)
                            || i.title.to_lowercase().contains(query)
                    })
                    .take(8)
                    .map(|(index, _)| PaletteItem::Issue(index)),
            );
        }
        items
    }
    fn run_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.commands {
            return;
        }
        if let Some(item) = self.palette_items(cx).into_iter().nth(self.palette_index) {
            self.run_palette_item(item, window, cx);
        }
    }
    fn run_palette_item(&mut self, item: PaletteItem, window: &mut Window, cx: &mut Context<Self>) {
        match item {
            PaletteItem::Action("New issue", ..) => self.open_form(false, window, cx),
            PaletteItem::Action("Refresh issues", ..) => {
                self.close_overlay(window, cx);
                self.refresh(false, cx);
            }
            PaletteItem::Action("Search issues", ..) => {
                self.commands = false;
                self.go("issues", cx);
                self.search.update(cx, |s, cx| s.focus(window, cx));
            }
            PaletteItem::Action(..) => {
                self.close_overlay(window, cx);
                self.dark = !self.dark;
                theme::apply(self.dark, cx);
            }
            PaletteItem::Go(_, path, _) => {
                self.close_overlay(window, cx);
                self.go(path, cx);
            }
            PaletteItem::Issue(index) => {
                self.close_overlay(window, cx);
                self.go("issues", cx);
                self.select_issue(index, window, cx);
            }
        }
        cx.notify();
    }
    /// Shared by the sidebar and the palette so both reach a view the same way.
    fn go(&mut self, path: &str, cx: &mut Context<Self>) {
        match path {
            "issues" => {
                self.commands = false;
                self.sprints_view = false;
                self.page = None;
                cx.notify();
            }
            "sprints" => self.show_sprints(cx),
            _ => {
                if let Some(page) = pages::Page::from_nav(path) {
                    self.show_page(page, cx);
                }
            }
        }
    }
    fn confirm_sign_out(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.saving {
            return;
        }
        self.return_focus = window.focused(cx);
        self.confirm_logout = true;
        window.focus(&self.cancel_focus, cx);
        cx.notify();
    }
    fn save_issue(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.demo {
            self.error = Some("Sample mode is read-only. Sign in to create or edit issues.".into());
            cx.notify();
            return;
        }
        if self.saving || !self.can_write() {
            return;
        }
        let title = self.title.read(cx).value().to_string();
        let description = self.description.read(cx).value().to_string();
        if title.trim().is_empty() {
            self.error = Some("An issue title is required.".into());
            cx.notify();
            return;
        }
        let (Some(client), Some(slug)) = (self.client.clone(), self.slug()) else {
            return;
        };
        let key = self.edit_key.clone();
        let draft_key = (slug.clone(), key.clone());
        let project = state::project_key(&self.projects, self.project.as_deref());
        let revision = self.session_revision.current();
        self.list_revision.next();
        self.loading = false;
        self.saving = true;
        self.error = None;
        cx.spawn_in(window, async move |view, cx| {
            let result = smol::unblock(move || match key {
                Some(key) => client.update_issue(&slug, &key, &title, &description),
                None => {
                    client.create_issue_in_project(&slug, &title, &description, project.as_deref())
                }
            })
            .await;
            let _ = view.update_in(cx, |this, window, cx| {
                if !this.session_revision.accepts(revision) {
                    return;
                }
                this.saving = false;
                match result {
                    Ok(issue) => {
                        this.form_drafts.remove(&draft_key);
                        if let Some(row) = this.issues.iter_mut().find(|i| i.id == issue.id) {
                            *row = issue.clone();
                        } else {
                            this.issues.insert(0, issue.clone());
                        }
                        let saved_id = issue.id.clone();
                        this.selected = Some(issue);
                        this.detail_revision.next();
                        this.comments.clear();
                        this.detail_loading = false;
                        this.editing = false;
                        this.notice = Some("Issue saved.".into());
                        this.title.update(cx, |s, cx| s.set_value("", window, cx));
                        this.description
                            .update(cx, |s, cx| s.set_value("", window, cx));
                        window.focus(this.return_focus.as_ref().unwrap_or(&this.focus), cx);
                        if let Some(index) =
                            this.issues.iter().position(|issue| issue.id == saved_id)
                        {
                            this.select_issue(index, window, cx);
                        }
                    }
                    Err(e) => this.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn post(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.saving
            || !self.can_write()
            || self.commands
            || self.editing
            || self.confirm_logout
            || self.quit_prompt
            || self.detail_loading
        {
            return;
        }
        if self.demo {
            self.error = Some("Sample mode is read-only. Sign in to post updates.".into());
            cx.notify();
            return;
        }
        let body = self.composer.read(cx).value().to_string();
        if body.trim().is_empty() {
            return;
        }
        let (Some(client), Some(slug), Some(issue)) =
            (self.client.clone(), self.slug(), self.selected.clone())
        else {
            return;
        };
        let revision = self.session_revision.current();
        let detail = self.detail_revision.current();
        self.list_revision.next();
        self.loading = false;
        self.saving = true;
        self.error = None;
        cx.spawn_in(window, async move |view, cx| {
            let draft_key = (slug.clone(), issue.key.clone());
            let result = smol::unblock(move || {
                client.add_comment(&slug, &issue.key, &body, Some("progress"))
            })
            .await;
            let _ = view.update_in(cx, |this, window, cx| {
                if !this.session_revision.accepts(revision) || !this.detail_revision.accepts(detail)
                {
                    return;
                }
                this.saving = false;
                match result {
                    Ok(comment) => {
                        this.comments.push(comment);
                        this.drafts.remove(&draft_key);
                        this.composer
                            .update(cx, |s, cx| s.set_value("", window, cx));
                        this.notice = Some("Update posted.".into());
                    }
                    Err(e) => this.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn change_status(&mut self, status: String, cx: &mut Context<Self>) {
        self.mutate_issue(IssueMutation::Status(status), cx);
    }
    fn set_assignee(&mut self, assignee: Option<String>, cx: &mut Context<Self>) {
        self.mutate_issue(IssueMutation::Assignee(assignee), cx);
    }
    fn toggle_label(&mut self, id: String, cx: &mut Context<Self>) {
        let Some(issue) = self.selected.as_ref() else {
            return;
        };
        let mut ids: Vec<String> = issue.labels.iter().map(|l| l.id.clone()).collect();
        match ids.iter().position(|l| *l == id) {
            Some(i) => {
                ids.remove(i);
            }
            None => ids.push(id),
        }
        self.mutate_issue(IssueMutation::Labels(ids), cx);
    }
    /// One server write against the selected issue. The reply replaces both the
    /// selection and its list row so every pane agrees.
    fn mutate_issue(&mut self, mutation: IssueMutation, cx: &mut Context<Self>) {
        if self.saving
            || !self.can_write()
            || self.detail_loading
            || self.commands
            || self.editing
            || self.confirm_logout
            || self.quit_prompt
        {
            return;
        }
        if self.demo {
            self.notice = Some("Sample mode is read-only.".into());
            cx.notify();
            return;
        }
        let (Some(client), Some(slug), Some(issue)) =
            (self.client.clone(), self.slug(), self.selected.clone())
        else {
            return;
        };
        let revision = self.session_revision.current();
        let detail = self.detail_revision.current();
        self.list_revision.next();
        self.loading = false;
        self.saving = true;
        let saved = mutation.notice();
        cx.spawn(async move |view, cx| {
            let result = smol::unblock(move || -> anyhow::Result<Issue> {
                match mutation {
                    IssueMutation::Status(status) => {
                        client.update_status(&slug, &issue.key, &status)
                    }
                    IssueMutation::Assignee(assignee) => client.patch_issue(
                        &slug,
                        &issue.key,
                        serde_json::json!({ "assignee_id": assignee }),
                    ),
                    IssueMutation::Labels(ids) => {
                        let labels = client.set_labels(&slug, &issue.key, &ids)?;
                        Ok(Issue { labels, ..issue })
                    }
                }
            })
            .await;
            let _ = view.update(cx, |this, cx| {
                if !this.session_revision.accepts(revision) || !this.detail_revision.accepts(detail)
                {
                    return;
                }
                this.saving = false;
                match result {
                    Ok(issue) => {
                        if let Some(row) = this.issues.iter_mut().find(|i| i.id == issue.id) {
                            *row = issue.clone();
                        }
                        this.selected = Some(issue);
                        this.notice = Some(saved.into());
                    }
                    Err(e) => this.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn logout(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.saving {
            return;
        }
        let client = self.client.clone();
        let server = self.server.clone();
        self.list_revision.next();
        self.loading = false;
        self.saving = true;
        self.error = None;
        cx.spawn_in(window, async move |view, cx| {
            let result = smol::unblock(move || -> anyhow::Result<()> {
                if let Some(client) = client {
                    client.revoke()?;
                }
                credentials::delete(&server)
            })
            .await;
            let _ = view.update_in(cx, |this, window, cx| {
                this.saving = false;
                match result {
                    Ok(()) => {
                        this.session_revision.next();
                        this.list_revision.next();
                        this.detail_revision.next();
                        this.client = None;
                        this.identity = None;
                        this.issues.clear();
                        this.projects.clear();
                        this.members.clear();
                        this.labels.clear();
                        this.assignee = None;
                        this.selected = None;
                        this.comments.clear();
                        this.evidence = Evidence::default();
                        this.drafts.clear();
                        this.form_drafts.clear();
                        this.project = None;
                        this.status = None;
                        this.workspace = 0;
                        this.next_cursor = None;
                        this.edit_key = None;
                        this.editing = false;
                        this.commands = false;
                        this.detail_loading = false;
                        this.clear_sprints();
                        this.sprints_view = false;
                        this.composer
                            .update(cx, |s, cx| s.set_value("", window, cx));
                        this.title.update(cx, |s, cx| s.set_value("", window, cx));
                        this.description
                            .update(cx, |s, cx| s.set_value("", window, cx));
                        this.search.update(cx, |s, cx| s.set_value("", window, cx));
                        window.focus(&this.focus, cx);
                        this.confirm_logout = false;
                        this.demo = false;
                        this.loading = false;
                        this.notice = Some("Signed out. Desktop access revoked.".into());
                    }
                    Err(e) => {
                        this.error = Some(format!(
                            "Could not complete sign-out: {e}. Retry to revoke access."
                        ))
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn open_web(&self, path: &str, cx: &mut App) {
        if !self.demo {
            cx.open_url(&format!("{}{path}", self.server));
        }
    }
    fn move_selection(&mut self, offset: isize, window: &mut Window, cx: &mut Context<Self>) {
        if self.commands {
            let count = self.palette_items(cx).len();
            if count > 0 {
                self.palette_index =
                    (self.palette_index as isize + offset).rem_euclid(count as isize) as usize;
                cx.notify();
            }
            return;
        }
        if self.editing || self.confirm_logout || self.quit_prompt || self.sprints_view {
            return;
        }
        let indices = self
            .visible_groups(cx)
            .into_iter()
            .flat_map(|(_, members)| members)
            .collect::<Vec<_>>();
        if indices.is_empty() {
            return;
        }
        let current = self.selected.as_ref().and_then(|selected| {
            indices
                .iter()
                .position(|i| self.issues[*i].id == selected.id)
        });
        let next = match current {
            Some(i) => (i as isize + offset).clamp(0, indices.len() as isize - 1) as usize,
            None => 0,
        };
        self.select_issue(indices[next], window, cx);
    }
    /// True when a bare letter should act on the list rather than type somewhere.
    fn list_keys_active(&self, window: &Window, cx: &App) -> bool {
        let overlay = self.commands || self.editing || self.confirm_logout || self.quit_prompt;
        let typing = [&self.search, &self.palette, &self.title, &self.server_input]
            .iter()
            .any(|s| s.focus_handle(cx).is_focused(window))
            || [&self.composer, &self.description]
                .iter()
                .any(|s| s.focus_handle(cx).is_focused(window));
        !overlay && !typing && self.page.is_none() && !self.sprints_view
    }
    /// `s` advances the selected issue to the next workflow status.
    fn cycle_status(&mut self, cx: &mut Context<Self>) {
        if !self.can_write() || self.saving || self.detail_loading {
            return;
        }
        let Some(current) = self.selected.as_ref().map(|i| i.status.clone()) else {
            return;
        };
        let next = STATUSES
            .iter()
            .position(|s| *s == current)
            .map(|i| STATUSES[(i + 1) % STATUSES.len()])
            .unwrap_or(STATUSES[0]);
        self.change_status(next.into(), cx);
    }
    fn seed_demo(&mut self) {
        self.identity=serde_json::from_value(serde_json::json!({"token_kind":"desktop","user":{"id":"sample","name":"Sabari","email":"Sample account"},"memberships":[{"id":"sample","workspace_id":"sample","workspace_slug":"velvet","workspace_name":"Velvet","issue_prefix":"VEL","role":"member"}]})).ok();
        self.projects = serde_json::from_value(
            serde_json::json!([{"id":"sample-project-id","key":"desktop","name":"Desktop"}]),
        )
        .unwrap_or_default();
        self.members = serde_json::from_value(serde_json::json!([
            {"id":"sample-user","name":"Sabari","email":"sample@example.com"},
            {"id":"sample-agent","name":"Agent","email":"agent@example.com"}
        ]))
        .unwrap_or_default();
        self.labels = [
            ("l-auth", "auth"),
            ("l-desktop", "desktop"),
            ("l-release", "release"),
            ("l-ux", "ux"),
        ]
        .into_iter()
        .map(|(id, name)| Label {
            id: id.into(),
            name: name.into(),
        })
        .collect();
        let days_ago = |d: i64| state::format_rfc3339(Self::now() - d * 86_400);
        let label = |id: &str, name: &str| Label {
            id: id.into(),
            name: name.into(),
        };
        self.issues=[("Build the native workspace shell","in_progress",2,Some("sample-user"),vec![label("l-desktop","desktop"),label("l-ux","ux")],2),("Add browser sign-in","todo",1,Some("sample-user"),vec![label("l-auth","auth")],3),("Connect issue details","todo",2,None,vec![label("l-desktop","desktop")],5),("Write a work log","backlog",3,None,vec![],14),("Add keyboard navigation","todo",0,Some("sample-agent"),vec![label("l-ux","ux")],7),("Package the macOS app","done",2,Some("sample-user"),vec![label("l-release","release")],21)].into_iter().enumerate().map(|(i,(title,status,priority,assignee,labels,age))|Issue{id:format!("sample-{i}"),key:format!("VEL-{}",142+i),title:title.into(),description:"Bring issues, project context, and work logs into one native workspace.\n\nKeep the interface fast, quiet, and keyboard-first.\n\n### Checklist\n- [x] Workspace switcher\n- [x] Issue list and detail\n- [ ] Command palette\n\nThis is **sample data**, not your project’s current work.".into(),status:status.into(),priority,project_id:Some("sample-project-id".into()),milestone_id:Some(if i < 3 {"sample-shell"} else {"sample-release"}.into()),assignee_id:assignee.map(Into::into),updated_at:days_ago(age),labels}).collect();
        self.selected = self.issues.first().cloned();
        self.evidence = serde_json::from_value(serde_json::json!({"pull_requests":[
            {"number":42,"title":"feat: native shell scaffolding","state":"closed","merged_at":"2026-11-04T10:00:00Z","html_url":""},
            {"number":47,"title":"Searchable command palette","state":"open","draft":true,"html_url":""}
        ]}))
        .unwrap_or_default();
        self.sprints = serde_json::from_value(serde_json::json!([{"id":"sample-sprint","project_id":"sample-project-id","name":"October","starts_on":"2026-10-01","ends_on":"2026-10-31","state":"active"}])).unwrap_or_default();
        self.sprint = Some("sample-sprint".into());
        self.milestones = serde_json::from_value(serde_json::json!([
            {"id":"sample-shell","name":"Native workspace","status":"in_progress","target_date":"2026-10-15","issue_counts":{"in_progress":1,"todo":2}},
            {"id":"sample-release","name":"Preview release","status":"planned","target_date":null,"issue_counts":{"backlog":1,"todo":1,"done":1}}
        ])).unwrap_or_default();
    }
}

impl Focusable for Velvet {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Velvet {
    fn label(&self, text: impl Into<SharedString>) -> Stateful<Div> {
        let text = text.into();
        div()
            .id(text.clone())
            .role(Role::Label)
            .aria_label(text.clone())
            .text_size(px(14.))
            .text_color(self.palette().muted)
            .child(text)
    }
    /// A left-aligned sidebar row: 16px icon, then the label that names it.
    fn nav_row(
        &self,
        id: impl Into<ElementId>,
        label: &str,
        icon: Lucide,
        current: bool,
        count: Option<String>,
    ) -> Button {
        let p = self.palette();
        Button::new(id)
            .ghost()
            .accessibility_label(if current {
                format!("{label}, current view")
            } else {
                label.to_owned()
            })
            .w_full()
            .h(px(28.))
            .px_2()
            .text_size(px(14.))
            .when(current, |b| b.bg(p.paper).border_1().border_color(p.border))
            .child(
                h_flex()
                    .w_full()
                    .gap_2()
                    .child(Icon::new(icon).size(px(15.)).text_color(if current {
                        p.ink
                    } else {
                        p.secondary
                    }))
                    .child(
                        div()
                            .flex_1()
                            .when(current, |d| d.font_weight(FontWeight::MEDIUM))
                            .child(label.to_owned()),
                    )
                    .when_some(count, |r, count| {
                        r.child(div().text_size(px(12.)).text_color(p.muted).child(count))
                    }),
            )
    }
    /// Dense two-line list row, with a 2px ink rule marking the selection so it never
    /// depends on the background colour alone.
    fn row_content(&self, selected: bool, top: impl IntoElement, bottom: impl IntoElement) -> Div {
        let p = self.palette();
        v_flex()
            .w_full()
            .min_w_0()
            .pl_2()
            .border_l_2()
            .border_color(if selected { p.ink } else { transparent_black() })
            .child(top)
            .child(bottom)
    }
    fn row_title(title: String) -> Div {
        div().text_size(px(16.)).truncate().child(title)
    }
    fn section_label(&self, text: &'static str) -> Div {
        div()
            .mt_3()
            .mb_1()
            .px_2()
            .text_size(px(11.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(self.palette().secondary)
            .child(text.to_uppercase())
    }
    fn workspace_menu(&self, cx: &Context<Self>) -> AnyElement {
        let memberships = self
            .identity
            .as_ref()
            .map(|i| i.memberships.clone())
            .unwrap_or_default();
        let name = memberships
            .get(self.workspace)
            .map(|w| w.workspace_name.clone())
            .unwrap_or_else(|| "Velvet".into());
        let p = self.palette();
        let view = cx.entity().downgrade();
        Button::new("workspace")
            .ghost()
            .accessibility_label(format!("Organisation: {name}. Switch organisation"))
            .child(
                h_flex()
                    .w_full()
                    .justify_between()
                    .gap_2()
                    .child(
                        div()
                            .font_weight(FontWeight::SEMIBOLD)
                            .truncate()
                            .child(name),
                    )
                    .child(div().text_color(p.muted).child("⇅")),
            )
            .px_2()
            .w_full()
            .h(px(36.))
            .text_size(px(14.))
            .disabled(self.saving)
            // Advertise accessibility Press; the dropdown opens on mouse-down.
            .on_click(|_, _, _| {})
            .dropdown_menu(move |mut menu, _, _| {
                for (index, membership) in memberships.iter().enumerate() {
                    let view = view.clone();
                    menu = menu.item(
                        PopupMenuItem::new(membership.workspace_name.clone()).on_click(
                            move |_, window, cx| {
                                let _ = view.update(cx, |this, cx| {
                                    this.switch_workspace(index, window, cx)
                                });
                            },
                        ),
                    );
                }
                menu
            })
            .into_any_element()
    }
    fn project_menu(&self, cx: &Context<Self>) -> AnyElement {
        let mut choices = vec![(None, "All projects".to_owned())];
        choices.extend(
            self.projects
                .iter()
                .map(|p| (Some(p.id.clone()), p.name.clone())),
        );
        let label = choices
            .iter()
            .find(|(id, _)| id == &self.project)
            .map(|(_, name)| name.clone())
            .unwrap_or_else(|| "All projects".into());
        let view = cx.entity().downgrade();
        Button::new("project-filter")
            .icon(Icon::new(Lucide::Folder))
            .label(label)
            .outline()
            .small()
            .dropdown_caret(true)
            // Advertise accessibility Press; the dropdown opens on mouse-down.
            .on_click(|_, _, _| {})
            .dropdown_menu(move |mut menu, _, _| {
                for (id, name) in &choices {
                    let id = id.clone();
                    let view = view.clone();
                    menu = menu.item(PopupMenuItem::new(name.clone()).on_click(move |_, _, cx| {
                        let _ = view.update(cx, |this, cx| {
                            this.project = id.clone();
                            if this.sprints_view {
                                let next = state::default_sprint(
                                    &this.sprints,
                                    this.project.as_deref(),
                                    this.sprint.as_deref(),
                                );
                                if next != this.sprint {
                                    this.select_sprint(next, cx);
                                }
                            }
                            cx.notify();
                        });
                    }));
                }
                menu
            })
            .into_any_element()
    }
    fn status_menu(&self, mutation: bool, cx: &Context<Self>) -> AnyElement {
        let current = if mutation {
            self.selected.as_ref().map(|i| i.status.as_str())
        } else {
            self.status.as_deref()
        };
        let label = current
            .map(status_label)
            .unwrap_or("All statuses")
            .to_owned();
        let view = cx.entity().downgrade();
        let target = self
            .selected
            .as_ref()
            .map(|issue| (self.slug(), issue.key.clone()));
        let p = self.palette();
        let current_owned = current.map(str::to_owned);
        Button::new(if mutation {
            "issue-status"
        } else {
            "status-filter"
        })
        .when_some(current, |b, status| b.icon(status_icon(status, p)))
        .when(current.is_none(), |b| {
            b.icon(Icon::new(Lucide::CircleDashed))
        })
        .label(label)
        .outline()
        .dropdown_caret(true)
        .when(mutation, |b| b.w_full().justify_start())
        .when(!mutation, |b| b.small())
        .disabled(mutation && (!self.can_write() || self.saving || self.detail_loading))
        // Advertise accessibility Press; the dropdown opens on mouse-down.
        .on_click(|_, _, _| {})
        .dropdown_menu(move |mut menu, _, _| {
            // Items carry status icons, so the check mark must sit on the right.
            menu = menu.check_side(Side::Right);
            if !mutation {
                let view = view.clone();
                menu = menu.item(
                    PopupMenuItem::new("All statuses").on_click(move |_, _, cx| {
                        let _ = view.update(cx, |this, cx| {
                            this.status = None;
                            cx.notify();
                        });
                    }),
                );
            }
            for status in STATUSES {
                let view = view.clone();
                let target = target.clone();
                menu = menu.item(
                    PopupMenuItem::new(status_label(status))
                        .icon(status_icon(status, p))
                        .checked(current_owned.as_deref() == Some(status))
                        .on_click(move |_, _, cx| {
                            let _ = view.update(cx, |this, cx| {
                                if mutation {
                                    if this
                                        .selected
                                        .as_ref()
                                        .map(|issue| (this.slug(), issue.key.clone()))
                                        == target
                                    {
                                        this.change_status(status.into(), cx);
                                    }
                                } else {
                                    this.status = Some(status.into());
                                    cx.notify();
                                }
                            });
                        }),
                );
            }
            menu
        })
        .into_any_element()
    }
    /// Assignee picker. As a filter it narrows the list; as a mutation it writes
    /// the selected issue. Members come from the workspace member list.
    fn assignee_menu(&self, mutation: bool, cx: &Context<Self>) -> AnyElement {
        let current: Option<Option<String>> = if mutation {
            self.selected.as_ref().map(|i| i.assignee_id.clone())
        } else {
            self.assignee.clone()
        };
        let name_of = |id: &Option<String>| match id {
            None => "Unassigned".to_owned(),
            Some(id) => self
                .members
                .iter()
                .find(|m| &m.id == id)
                .map(|m| m.user.label())
                .unwrap_or_else(|| format!("Member {}", &id[..id.len().min(8)])),
        };
        let label = match &current {
            None if !mutation => "Anyone".to_owned(),
            None => "Unassigned".to_owned(),
            Some(id) => name_of(id),
        };
        let members: Vec<(String, String)> = self
            .members
            .iter()
            .map(|m| (m.id.clone(), m.user.label()))
            .collect();
        let view = cx.entity().downgrade();
        let target = self
            .selected
            .as_ref()
            .map(|issue| (self.slug(), issue.key.clone()));
        let checked = current.clone();
        let assigned = current.as_ref().is_some_and(|c| c.is_some());
        Button::new(if mutation {
            "issue-assignee"
        } else {
            "assignee-filter"
        })
        .accessibility_label(if mutation {
            format!("Assignee: {label}. Change assignee")
        } else {
            format!("Assignee filter: {label}")
        })
        .when(!assigned, |b| {
            b.icon(Icon::new(Lucide::CircleDashed)).label(label.clone())
        })
        .when(assigned, |b| {
            b.child(
                h_flex()
                    .gap_1p5()
                    .min_w_0()
                    .child(Avatar::new().name(label.clone()).xsmall())
                    .child(div().truncate().child(label.clone())),
            )
        })
        .outline()
        .dropdown_caret(true)
        .when(mutation, |b| b.w_full().justify_start())
        .when(!mutation, |b| b.small())
        .disabled(mutation && (!self.can_write() || self.saving || self.detail_loading))
        // Advertise accessibility Press; the dropdown opens on mouse-down.
        .on_click(|_, _, _| {})
        .dropdown_menu(move |mut menu, _, _| {
            menu = menu.check_side(Side::Right);
            let pick = |choice: Option<Option<String>>| {
                let view = view.clone();
                let target = target.clone();
                move |_: &ClickEvent, _: &mut Window, cx: &mut App| {
                    let _ = view.update(cx, |this, cx| {
                        if mutation {
                            if this
                                .selected
                                .as_ref()
                                .map(|issue| (this.slug(), issue.key.clone()))
                                == target
                            {
                                this.set_assignee(choice.clone().flatten(), cx);
                            }
                        } else {
                            this.assignee = choice.clone();
                            cx.notify();
                        }
                    });
                }
            };
            if !mutation {
                menu = menu.item(
                    PopupMenuItem::new("Anyone")
                        .checked(checked.is_none())
                        .on_click(pick(None)),
                );
            }
            menu = menu.item(
                PopupMenuItem::new("Unassigned")
                    .icon(Icon::new(Lucide::CircleDashed))
                    .checked(checked.as_ref().is_some_and(|c| c.is_none()))
                    .on_click(pick(Some(None))),
            );
            for (id, name) in &members {
                menu = menu.item(
                    PopupMenuItem::new(name.clone())
                        .icon(Icon::new(Lucide::UserRound))
                        .checked(checked.as_ref().is_some_and(|c| c.as_deref() == Some(id)))
                        .on_click(pick(Some(Some(id.clone())))),
                );
            }
            menu
        })
        .into_any_element()
    }
    /// Label picker for the selected issue: each row toggles one workspace label.
    fn labels_menu(&self, cx: &Context<Self>) -> AnyElement {
        let p = self.palette();
        let Some(issue) = self.selected.as_ref() else {
            return div().into_any_element();
        };
        let applied: Vec<String> = issue.labels.iter().map(|l| l.id.clone()).collect();
        let catalogue: Vec<(String, String)> = self
            .labels
            .iter()
            .map(|l| (l.id.clone(), l.name.clone()))
            .collect();
        let names = issue
            .labels
            .iter()
            .map(|l| l.name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        let view = cx.entity().downgrade();
        let target = (self.slug(), issue.key.clone());
        Button::new("issue-labels")
            .accessibility_label(if names.is_empty() {
                "Labels: none. Change labels".to_owned()
            } else {
                format!("Labels: {names}. Change labels")
            })
            .w_full()
            .h_auto()
            .min_h(px(28.))
            .py_1()
            .justify_start()
            .outline()
            .dropdown_caret(true)
            .disabled(!self.can_write() || self.saving || self.detail_loading)
            .child(if issue.labels.is_empty() {
                div()
                    .text_size(px(14.))
                    .text_color(p.secondary)
                    .child("None")
                    .into_any_element()
            } else {
                h_flex()
                    .flex_wrap()
                    .gap_1()
                    .children(issue.labels.iter().map(|l| {
                        div()
                            .h(px(20.))
                            .px_1p5()
                            .flex()
                            .items_center()
                            .rounded(px(4.))
                            .border_1()
                            .border_color(p.border)
                            .bg(p.paper)
                            .text_size(px(12.))
                            .child(l.name.clone())
                    }))
                    .into_any_element()
            })
            // Advertise accessibility Press; the dropdown opens on mouse-down.
            .on_click(|_, _, _| {})
            .dropdown_menu(move |mut menu, _, _| {
                if catalogue.is_empty() {
                    return menu.item(PopupMenuItem::new("No labels defined").disabled(true));
                }
                for (id, name) in &catalogue {
                    let view = view.clone();
                    let target = target.clone();
                    let id = id.clone();
                    menu = menu.item(
                        PopupMenuItem::new(name.clone())
                            .checked(applied.contains(&id))
                            .on_click(move |_, _, cx| {
                                let _ = view.update(cx, |this, cx| {
                                    if this
                                        .selected
                                        .as_ref()
                                        .map(|issue| (this.slug(), issue.key.clone()))
                                        == Some(target.clone())
                                    {
                                        this.toggle_label(id.clone(), cx);
                                    }
                                });
                            }),
                    );
                }
                menu
            })
            .into_any_element()
    }
    fn sidebar(&self, cx: &Context<Self>) -> AnyElement {
        let p = self.palette();
        // Grouped like the web shell: planning, activity, then work across organisations.
        let nav_button = |label: &'static str, path: &'static str, icon: Lucide| {
            let page = pages::Page::from_nav(path);
            let current = match path {
                "issues" => !self.sprints_view && self.page.is_none(),
                "sprints" => self.sprints_view,
                _ => page.is_some() && self.page == page,
            };
            // The work log keeps its historical id, which tests and scripts address.
            let id = if path == "worklog" {
                SharedString::from("worklog")
            } else {
                SharedString::from(format!("nav-{path}"))
            };
            // Counts show only what this window already knows: loaded issues, active sprint.
            let count = match path {
                "issues" if !self.issues.is_empty() => Some(self.issues.len().to_string()),
                "sprints" => self
                    .sprints
                    .iter()
                    .find(|s| s.state == "active")
                    .map(|s| s.name.clone()),
                _ => None,
            };
            self.nav_row(id, label, icon, current, count)
                .on_click(cx.listener(move |this, _, _, cx| this.go(path, cx)))
        };
        let nav = |range: std::ops::Range<usize>| {
            NAV[range]
                .iter()
                .map(|(label, path, icon)| nav_button(label, path, *icon))
        };
        let shell = v_flex()
            .w(px(240.))
            .h_full()
            .flex_shrink_0()
            .px_2()
            .pt_2()
            .gap_0p5()
            .border_r_1()
            .border_color(p.hair);
        self.glass_backed(shell, "glass-sidebar", px(0.), false, p.glass)
            .child(self.workspace_menu(cx))
            .child(
                Button::new("commands")
                    .accessibility_label("Search commands, Command K")
                    .w_full()
                    .h(px(28.))
                    .px_2()
                    .mt_1()
                    .rounded_full()
                    .bg(p.glass_strong)
                    .border_t_1()
                    .border_color(p.edge)
                    .child(
                        h_flex()
                            .w_full()
                            .gap_2()
                            .text_size(px(14.))
                            .child(Icon::new(Lucide::Search).size(px(15.)).text_color(p.muted))
                            .child(div().flex_1().text_color(p.secondary).child("Search"))
                            .child(Kbd::new(Keystroke::parse("cmd-k").unwrap()).outline()),
                    )
                    .on_click(cx.listener(|this, _, window, cx| this.open_commands(window, cx))),
            )
            .child(self.section_label("Workspace"))
            .children(nav(0..5))
            .child(self.section_label("Activity"))
            .children(nav(5..8))
            .child(self.section_label("Across organisations"))
            .children(nav(8..9))
            .child(div().flex_1())
            .child(self.account_menu(cx))
            .into_any_element()
    }
    /// Account, appearance and update controls live behind one menu so the sidebar
    /// stays navigation. The macOS Velvet menu offers the same update actions.
    fn account_menu(&self, cx: &Context<Self>) -> AnyElement {
        let p = self.palette();
        let name = self
            .identity
            .as_ref()
            .map(|i| i.user.label())
            .unwrap_or_default();
        let role = self
            .identity
            .as_ref()
            .and_then(|i| i.memberships.get(self.workspace))
            .map(|w| format!("{} access", state::role_label(&w.role)))
            .unwrap_or_default();
        let (auto_update, dark, demo) = (self.auto_update, self.dark, self.demo);
        let view = cx.entity().downgrade();
        Button::new("account")
            .ghost()
            .accessibility_label(format!("Account: {name}, {role}. Settings and sign out"))
            .w_full()
            .h(px(48.))
            .px_2()
            .mt_1()
            .mx_0()
            .border_t_1()
            .border_color(p.border)
            .rounded_none()
            .text_size(px(14.))
            .child(
                h_flex()
                    .w_full()
                    .min_w_0()
                    .gap_2()
                    .child(Avatar::new().name(name.clone()).xsmall())
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .items_start()
                            .child(
                                div()
                                    .w_full()
                                    .truncate()
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(name),
                            )
                            .child(div().text_size(px(12.)).text_color(p.secondary).child(role)),
                    )
                    .child(
                        Icon::new(Lucide::ChevronsUpDown)
                            .size(px(16.))
                            .text_color(p.muted),
                    ),
            )
            // Advertise accessibility Press; the dropdown opens on mouse-down.
            .on_click(|_, _, _| {})
            .dropdown_menu(move |menu, _, _| {
                let act = |f: fn(&mut Velvet, &mut Window, &mut Context<Velvet>)| {
                    let view = view.clone();
                    move |_: &ClickEvent, window: &mut Window, cx: &mut App| {
                        let _ = view.update(cx, |this, cx| f(this, window, cx));
                    }
                };
                menu.item(
                    PopupMenuItem::new("Automatic updates")
                        .checked(auto_update)
                        .on_click(act(|this, _, cx| this.toggle_auto_update(cx))),
                )
                .item(
                    PopupMenuItem::new(format!("Check for updates (v{})", update::CURRENT))
                        .icon(Icon::new(Lucide::Download))
                        .on_click(act(|this, _, cx| this.check_for_updates(true, cx))),
                )
                .item(
                    PopupMenuItem::new(if dark {
                        "Light appearance"
                    } else {
                        "Dark appearance"
                    })
                    .icon(Icon::new(if dark { Lucide::Sun } else { Lucide::Moon }))
                    .on_click(act(|this, _, cx| {
                        this.dark = !this.dark;
                        theme::apply(this.dark, cx);
                        cx.notify();
                    })),
                )
                .separator()
                .item(
                    PopupMenuItem::new(if demo {
                        "Exit sample workspace"
                    } else {
                        "Sign out…"
                    })
                    .icon(Icon::new(Lucide::LogOut))
                    .on_click(act(|this, window, cx| this.sign_out_or_exit(window, cx))),
                )
            })
            .into_any_element()
    }
    fn sign_out_or_exit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.demo {
            self.demo = false;
            self.identity = None;
            self.issues.clear();
            self.selected = None;
            self.clear_sprints();
            self.sprints_view = false;
        } else {
            self.confirm_sign_out(window, cx);
        }
        cx.notify();
    }
    /// Filtered issues grouped by status in workflow order, as the list draws them.
    // shortcut: every row is drawn, not virtualised; move to uniform_list past ~500 loaded issues.
    fn visible_groups(&self, cx: &App) -> Vec<(&'static str, Vec<usize>)> {
        let indices = state::matching_indices(
            &self.issues,
            &self.search.read(cx).value(),
            self.project.as_deref(),
            self.status.as_deref(),
            self.assignee.as_ref().map(|a| a.as_deref()),
        );
        STATUSES
            .iter()
            .map(|status| {
                let members = indices
                    .iter()
                    .copied()
                    .filter(|i| self.issues[*i].status == *status)
                    .collect::<Vec<_>>();
                (*status, members)
            })
            .filter(|(_, members)| !members.is_empty())
            .collect()
    }
    /// One 34px row: status shape, key, title, priority. The 2px ink rule marks the
    /// selection so it never depends on the background colour alone.
    fn issue_row(&self, index: usize, cx: &Context<Self>) -> Button {
        let p = self.palette();
        let issue = &self.issues[index];
        let selected = self.selected.as_ref().is_some_and(|s| s.id == issue.id);
        let done = matches!(issue.status.as_str(), "done" | "cancelled");
        let assignee = self.assignee_name(issue);
        let labels = issue
            .labels
            .iter()
            .map(|l| l.name.clone())
            .collect::<Vec<_>>();
        Button::new(("issue", index))
            .ghost()
            .accessibility_label(format!(
                "{}: {}, {}, priority {}, {}{}{}",
                issue.key,
                issue.title,
                status_label(&issue.status),
                issue.priority,
                assignee.as_deref().unwrap_or("unassigned"),
                if labels.is_empty() {
                    String::new()
                } else {
                    format!(", labels {}", labels.join(", "))
                },
                if selected { ", selected" } else { "" }
            ))
            .w_full()
            .h(px(34.))
            .justify_start()
            .pl_0()
            .pr_3()
            .rounded_none()
            .when(selected, |b| b.bg(p.surface))
            .border_b_1()
            .border_color(p.border)
            .child(
                h_flex()
                    .w_full()
                    .min_w_0()
                    .h_full()
                    .gap_2()
                    .pl_2()
                    .border_l_2()
                    .border_color(if selected { p.ink } else { transparent_black() })
                    .child(status_icon(&issue.status, p))
                    .child(
                        div()
                            .w(px(64.))
                            .flex_shrink_0()
                            .text_size(px(13.))
                            .text_color(p.muted)
                            .child(issue.key.clone()),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(px(14.))
                            .when(done, |d| d.text_color(p.secondary))
                            .child(issue.title.clone()),
                    )
                    .child(
                        div()
                            .flex_shrink_0()
                            .text_size(px(13.))
                            .text_color(p.secondary)
                            .child(format!("P{}", issue.priority)),
                    )
                    .child(
                        div()
                            .w(px(28.))
                            .flex_shrink_0()
                            .text_size(px(12.))
                            .text_color(p.muted)
                            .child(
                                state::short_age(&issue.updated_at, Self::now())
                                    .unwrap_or_default(),
                            ),
                    )
                    .child(match self.assignee_name(issue) {
                        Some(name) => Avatar::new().name(name).xsmall().into_any_element(),
                        None => div()
                            .size(px(20.))
                            .rounded_full()
                            .border_1()
                            .border_color(p.border)
                            .into_any_element(),
                    }),
            )
            .on_click(cx.listener(move |this, _, window, cx| this.select_issue(index, window, cx)))
    }
    fn issue_list(&self, cx: &Context<Self>) -> AnyElement {
        let p = self.palette();
        let visible = self.visible_groups(cx);
        let count = visible.iter().map(|(_, m)| m.len()).sum::<usize>();
        let mut groups = v_flex()
            .id("issue-list")
            .w_full()
            .h_full()
            .overflow_y_scroll();
        for (status, members) in visible {
            groups = groups.child(
                h_flex()
                    .id(SharedString::from(format!("group-{status}")))
                    .role(Role::Heading)
                    .aria_label(format!(
                        "{}, {} issues",
                        status_label(status),
                        members.len()
                    ))
                    .h(px(28.))
                    .px_3()
                    .gap_2()
                    .bg(p.surface)
                    .border_b_1()
                    .border_color(p.border)
                    .text_size(px(13.))
                    .child(status_icon(status, p).size(px(13.)))
                    .child(
                        div()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(p.secondary)
                            .child(status_label(status).to_owned()),
                    )
                    .child(
                        div()
                            .text_color(p.muted)
                            .child(format!("· {}", members.len())),
                    ),
            );
            groups = groups.children(members.into_iter().map(|i| self.issue_row(i, cx)));
        }
        let hint = |keys: &str, text: &'static str| {
            h_flex()
                .gap_1()
                .child(Kbd::new(Keystroke::parse(keys).unwrap()).outline())
                .child(div().text_color(p.muted).child(text))
        };
        // Near-opaque card floating over the vibrancy, per the glass mock.
        let card = v_flex()
            .size_full()
            .rounded(px(14.))
            .overflow_hidden()
            .bg(p.card)
            .border_t_1()
            .border_color(p.edge)
            .child(
                v_flex()
                    .p_2()
                    .gap_2()
                    .border_b_1()
                    .border_color(p.hair)
                    .child(Input::new(&self.search).aria_label("Search loaded issues"))
                    .child(
                        h_flex()
                            .gap_1p5()
                            .flex_wrap()
                            .child(self.project_menu(cx).into_any_element())
                            .child(self.status_menu(false, cx))
                            .child(self.assignee_menu(false, cx)),
                    ),
            )
            .when(self.loading, |v| {
                v.child(div().p_3().child(self.label("Loading issues…")))
            })
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .when(count > 0, |v| v.child(groups))
                    .when(count == 0 && !self.loading, |v| {
                        v.child(div().p_4().child(if self.issues.is_empty() {
                            "No issues yet. Create your first issue."
                        } else {
                            "No matching issues. Change your filters."
                        }))
                    }),
            )
            .when(self.next_cursor.is_some(), |v| {
                v.child(
                    Button::new("more")
                        .label("Load more issues")
                        .disabled(self.loading)
                        .w_full()
                        .rounded_none()
                        .on_click(cx.listener(|this, _, _, cx| this.refresh(true, cx))),
                )
            })
            .child(
                h_flex()
                    .h(px(32.))
                    .px_3()
                    .justify_between()
                    .border_t_1()
                    .border_color(p.border)
                    .text_size(px(13.))
                    .child(
                        div()
                            .text_color(p.muted)
                            .child(format!("{count} of {} loaded", self.issues.len())),
                    )
                    .child(
                        h_flex()
                            .gap_3()
                            .child(hint("j", "next"))
                            .child(hint("k", "previous"))
                            .child(hint("e", "edit")),
                    ),
            );
        v_flex()
            .w(px(400.))
            .flex_shrink_0()
            .h_full()
            .pl_3()
            .py_3()
            .child(card)
            .into_any_element()
    }
    /// Dashboard, projects, reports, feed, mentions, unlinked PRs and work log.
    fn page_view(&self, page: pages::Page, cx: &Context<Self>) -> AnyElement {
        let p = self.palette();
        let mut body = v_flex().id("page").overflow_y_scroll().p_6().gap_5().child(
            h_flex()
                .justify_between()
                .gap_2()
                .child(
                    div()
                        .id("page-heading")
                        .role(Role::Heading)
                        .aria_label(page.title())
                        .test_support()
                        .text_size(px(24.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(page.title()),
                )
                .child(
                    Button::new("page-refresh")
                        .ghost()
                        .label(if self.page_loading {
                            "Loading…"
                        } else {
                            "Refresh"
                        })
                        .disabled(self.page_loading)
                        .on_click(cx.listener(move |this, _, _, cx| this.show_page(page, cx))),
                ),
        );
        if self.demo {
            body = body.child(self.label("Sample mode has no server data for this page."));
        }
        let mut row_id = 0usize;
        for section in &self.page_sections {
            let mut list = v_flex().gap_1().child(
                div()
                    .text_size(px(14.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(p.secondary)
                    .child(section.title.clone()),
            );
            if section.rows.is_empty() && !self.page_loading {
                list = list.child(self.label(section.empty));
            }
            for row in &section.rows {
                let label = if row.detail.is_empty() {
                    row.title.clone()
                } else {
                    format!("{}, {}", row.title, row.detail)
                };
                let content = v_flex()
                    .w_full()
                    .min_w_0()
                    .gap_0p5()
                    .child(div().w_full().truncate().child(row.title.clone()))
                    .when(!row.detail.is_empty(), |v| {
                        v.child(
                            div()
                                .w_full()
                                .truncate()
                                .text_size(px(14.))
                                .text_color(p.muted)
                                .child(row.detail.clone()),
                        )
                    });
                let action = row.issue_key.clone().map(Ok).or(row.url.clone().map(Err));
                list = list.child(match action {
                    Some(target) => Button::new(("page-row", row_id))
                        .ghost()
                        .accessibility_label(label)
                        .w_full()
                        .h_auto()
                        .py_1p5()
                        .px_2()
                        .justify_start()
                        .child(content)
                        .on_click(cx.listener(move |this, _, window, cx| match &target {
                            Ok(key) => this.open_issue_key(key.clone(), window, cx),
                            Err(url) => cx.open_url(url),
                        }))
                        .into_any_element(),
                    None => div()
                        .id(("page-row", row_id))
                        .aria_label(label)
                        .w_full()
                        .py_1p5()
                        .px_2()
                        .child(content)
                        .into_any_element(),
                });
                row_id += 1;
            }
            body = body.child(list);
        }
        div()
            .flex_1()
            .min_w_0()
            .h_full()
            .p_3()
            .child(self.card(p, body.size_full()))
            .into_any_element()
    }
    fn sprint_list(&self, cx: &Context<Self>) -> AnyElement {
        let p = self.palette();
        let visible = state::visible_sprints(&self.sprints, self.project.as_deref());
        let list = self
            .card(p, v_flex().size_full())
            .child(
                v_flex()
                    .p_4()
                    .gap_3()
                    .child(
                        div()
                            .id("sprints-heading")
                            .role(Role::Heading)
                            .aria_label("Sprints")
                            .test_support()
                            .text_size(px(24.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Sprints"),
                    )
                    .child(
                        h_flex()
                            .justify_between()
                            .child(self.project_menu(cx))
                            .child(
                                Button::new("refresh-sprints")
                                    .ghost()
                                    .label("Refresh")
                                    .disabled(self.sprint_loading || self.demo)
                                    .on_click(cx.listener(|this, _, _, cx| this.load_sprints(cx))),
                            ),
                    ),
            )
            .when(self.sprint_loading && self.sprints.is_empty(), |v| {
                v.child(div().p_3().child(self.label("Loading sprints…")))
            })
            .when(visible.is_empty() && !self.sprint_loading, |v| {
                v.child(div().p_4().child(if self.sprints.is_empty() {
                    "No sprints yet. Plan one in the web app."
                } else {
                    "No sprints in this project. Choose another project."
                }))
            })
            .child(
                v_flex()
                    .id("sprint-list")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .children(visible.into_iter().map(|index| {
                        let sprint = &self.sprints[index];
                        let selected = self.sprint.as_deref() == Some(sprint.id.as_str());
                        let id = sprint.id.clone();
                        let dates = format!("{} to {}", sprint.starts_on, sprint.ends_on);
                        let state = state::sprint_state_label(&sprint.state).to_owned();
                        Button::new(("sprint", index))
                            .ghost()
                            .accessibility_label(format!(
                                "{}: {state}, {dates}{}",
                                sprint.name,
                                if selected { ", selected" } else { "" }
                            ))
                            .w_full()
                            .h(px(64.))
                            .justify_start()
                            .pl_2()
                            .pr_3()
                            .rounded_none()
                            .when(selected, |b| b.bg(p.surface))
                            .border_b_1()
                            .border_color(p.border)
                            .child(self.row_content(
                                selected,
                                Self::row_title(sprint.name.clone()),
                                self.label(format!("{state} · {dates}")),
                            ))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.select_sprint(Some(id.clone()), cx)
                            }))
                    })),
            );
        v_flex()
            .w(px(340.))
            .h_full()
            .flex_shrink_0()
            .p_3()
            .child(list)
            .into_any_element()
    }
    fn sprint_board(&self, cx: &Context<Self>) -> AnyElement {
        let p = self.palette();
        let Some(sprint) = self
            .sprint
            .as_ref()
            .and_then(|id| self.sprints.iter().find(|s| &s.id == id))
        else {
            return div()
                .flex_1()
                .min_w_0()
                .h_full()
                .py_3()
                .pr_3()
                .child(
                    self.card(p, v_flex().size_full().p_6().gap_3())
                        .child(div().text_size(px(24.)).child("Plans, in focus."))
                        .child(self.label("Choose a sprint to see its milestones and progress.")),
                )
                .into_any_element();
        };
        let path = format!(
            "/w/{}/sprints/{}",
            self.slug().unwrap_or_default(),
            sprint.id
        );
        let board = v_flex()
            .id("sprint-board")
            .overflow_y_scroll()
            .p_6()
            .gap_4()
            .child(
                h_flex()
                    .justify_between()
                    .gap_2()
                    .child(self.label(format!(
                        "{} · {} to {}",
                        state::sprint_state_label(&sprint.state),
                        sprint.starts_on,
                        sprint.ends_on
                    )))
                    .child(
                        Button::new("sprint-web")
                            .ghost()
                            .label("Open in web ↗")
                            .disabled(self.demo)
                            .on_click(cx.listener(move |this, _, _, cx| this.open_web(&path, cx))),
                    ),
            )
            .child(
                div()
                    .id("sprint-heading")
                    .role(Role::Heading)
                    .aria_label(sprint.name.clone())
                    .test_support()
                    .text_size(px(24.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(sprint.name.clone()),
            )
            .child(self.label("Milestones and their issues are read-only here. Plan and change them in the web app."))
            .when(self.sprint_loading && self.milestones.is_empty(), |v| {
                v.child(self.label("Loading milestones…"))
            })
            .when(!self.sprint_loading && self.milestones.is_empty(), |v| {
                v.child(self.label("No milestones in this sprint yet."))
            })
            .children(self.milestones.iter().enumerate().map(|(index, milestone)| {
                let (done, total) = state::milestone_progress(milestone);
                let expanded = self.milestone.as_deref() == Some(milestone.id.as_str());
                let status = state::milestone_status_label(&milestone.status).to_owned();
                let target = milestone
                    .target_date
                    .as_ref()
                    .map(|date| format!(" · due {date}"))
                    .unwrap_or_default();
                let summary = format!("{status}{target} · {done} of {total} done");
                let id = milestone.id.clone();
                v_flex()
                    .border_1()
                    .border_color(p.border)
                    .rounded(px(8.))
                    .child(
                        Button::new(("milestone", index))
                            .ghost()
                            .accessibility_label(format!(
                                "{}: {summary}, {}",
                                milestone.name,
                                if expanded { "expanded" } else { "collapsed" }
                            ))
                            .w_full()
                            .h(px(68.))
                            .justify_start()
                            .px_3()
                            .child(
                                v_flex()
                                    .gap_1()
                                    .w_full()
                                    .min_w_0()
                                    .child(
                                        div()
                                            .text_size(px(16.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .child(format!(
                                                "{} {}",
                                                if expanded { "▾" } else { "▸" },
                                                milestone.name
                                            )),
                                    )
                                    .child(self.label(summary)),
                            )
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.toggle_milestone(id.clone(), cx)
                            })),
                    )
                    .when(expanded, |v| {
                        v.child(self.milestone_issue_rows(cx))
                    })
            }));
        div()
            .flex_1()
            .min_w_0()
            .h_full()
            .py_3()
            .pr_3()
            .child(self.card(p, board.size_full()))
            .into_any_element()
    }
    fn milestone_issue_rows(&self, cx: &Context<Self>) -> AnyElement {
        let p = self.palette();
        let Some(issues) = self.milestone_issues.as_ref() else {
            return div()
                .p_3()
                .child(self.label("Loading issues…"))
                .into_any_element();
        };
        if issues.is_empty() {
            return div()
                .p_3()
                .child(self.label("No issues in this milestone."))
                .into_any_element();
        }
        v_flex()
            .border_t_1()
            .border_color(p.border)
            .children(issues.iter().enumerate().map(|(index, issue)| {
                let target = issue.clone();
                Button::new(("milestone-issue", index))
                    .ghost()
                    .accessibility_label(format!(
                        "{}: {}, {}",
                        issue.key,
                        issue.title,
                        status_label(&issue.status)
                    ))
                    .w_full()
                    .h(px(40.))
                    .justify_start()
                    .px_3()
                    .rounded_none()
                    .child(
                        h_flex()
                            .gap_3()
                            .w_full()
                            .min_w_0()
                            .child(status_icon(&issue.status, p))
                            .child(self.label(issue.key.clone()))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .truncate()
                                    .child(issue.title.clone()),
                            )
                            .child(self.label(status_label(&issue.status).to_owned())),
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.open_issue(target.clone(), window, cx)
                    }))
            }))
            .into_any_element()
    }
    fn detail(&self, window: &Window, cx: &Context<Self>) -> AnyElement {
        let p = self.palette();
        let Some(issue) = self.selected.as_ref() else {
            return div()
                .flex_1()
                .min_w_0()
                .h_full()
                .p_3()
                .child(
                    self.card(p, v_flex().size_full().p_6().gap_3())
                        .child(div().text_size(px(20.)).child("Your work, in focus."))
                        .child(self.label("Choose an issue to see its description and updates.")),
                )
                .into_any_element();
        };
        let narrow = window.viewport_size().width < px(1200.);
        let project = self.project_name(issue);
        let milestone = issue
            .milestone_id
            .as_ref()
            .and_then(|id| self.milestones.iter().find(|m| &m.id == id))
            .map(|m| m.name.clone());
        // Stacked label/value like the web's metadata column: 11px uppercase
        // caption, then the value or its picker on the next line.
        let field = |label: &'static str, value: AnyElement| {
            v_flex()
                .gap_1()
                .mb_2()
                .child(
                    div()
                        .text_size(px(11.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(p.secondary)
                        .child(label.to_uppercase()),
                )
                .child(div().w_full().min_w_0().child(value))
        };
        let plain = |text: String, icon: Option<Lucide>| {
            h_flex()
                .min_h(px(28.))
                .gap_1p5()
                .text_size(px(14.))
                .when_some(icon, |r, icon| {
                    r.child(Icon::new(icon).size(px(14.)).text_color(p.secondary))
                })
                .child(div().truncate().child(text))
                .into_any_element()
        };
        let hint = |keys: &str, text: &'static str| {
            h_flex()
                .gap_2()
                .child(Kbd::new(Keystroke::parse(keys).unwrap()).outline())
                .child(div().text_size(px(13.)).text_color(p.muted).child(text))
        };
        let rail = v_flex()
            .w(px(260.))
            .h_full()
            .flex_shrink_0()
            .p_4()
            .gap_1()
            .rounded(px(14.))
            .border_t_1()
            .border_color(p.edge);
        let rail = self
            .glass_backed(rail, "glass-rail", px(14.), false, p.glass)
            .child(field("Status", self.status_menu(true, cx)))
            .child(field(
                "Priority",
                plain(format!("P{}", issue.priority), Some(Lucide::SignalHigh)),
            ))
            .child(field(
                "Project",
                plain(project.clone(), Some(Lucide::Folder)),
            ))
            .when_some(milestone, |v, name| {
                v.child(field("Milestone", plain(name, Some(Lucide::Milestone))))
            })
            .child(field("Assignee", self.assignee_menu(true, cx)))
            .child(field("Labels", self.labels_menu(cx)))
            .child(div().h(px(1.)).mb_3().bg(p.border))
            .child(
                div()
                    .text_size(px(13.))
                    .text_color(p.secondary)
                    .child("Evidence"),
            )
            .when(self.evidence.pull_requests.is_empty(), |v| {
                v.child(
                    div()
                        .text_size(px(13.))
                        .text_color(p.muted)
                        .child("No linked pull requests."),
                )
            })
            .children(
                self.evidence
                    .pull_requests
                    .iter()
                    .enumerate()
                    .map(|(i, pr)| {
                        let state = if pr.merged_at.is_some() {
                            "merged"
                        } else if pr.draft {
                            "draft"
                        } else {
                            pr.state.as_str()
                        };
                        let url = pr.html_url.clone();
                        Button::new(("evidence", i))
                            .ghost()
                            .small()
                            .w_full()
                            .justify_start()
                            .px_1()
                            .accessibility_label(format!(
                                "Pull request {} {}, {state}",
                                pr.number, pr.title
                            ))
                            .disabled(url.is_empty())
                            .child(
                                h_flex()
                                    .w_full()
                                    .min_w_0()
                                    .gap_1p5()
                                    .text_size(px(13.))
                                    .child(
                                        Icon::new(Lucide::GitPullRequest)
                                            .size(px(14.))
                                            .text_color(p.secondary),
                                    )
                                    .child(
                                        div()
                                            .flex_shrink_0()
                                            .text_color(p.secondary)
                                            .child(format!("#{}", pr.number)),
                                    )
                                    .child(
                                        div().flex_1().min_w_0().truncate().child(pr.title.clone()),
                                    )
                                    .child(
                                        div()
                                            .flex_shrink_0()
                                            .text_color(if state == "merged" {
                                                p.done
                                            } else {
                                                p.muted
                                            })
                                            .child(state.to_owned()),
                                    ),
                            )
                            .on_click(move |_, _, cx| {
                                if let Some(url) = state::safe_external_url(&url) {
                                    cx.open_url(&url);
                                }
                            })
                    }),
            )
            .child(div().h(px(1.)).my_2().bg(p.border))
            .child(
                div()
                    .text_size(px(13.))
                    .text_color(p.secondary)
                    .line_height(relative(1.5))
                    .child(if self.demo {
                        "Sample data. Nothing is written to a server."
                    } else {
                        "Evidence never changes status. Labels are created in the web app."
                    }),
            )
            .child(
                v_flex()
                    .mt_3()
                    .gap_1()
                    .child(hint("e", "edit"))
                    .child(hint("s", "status"))
                    .child(hint("c", "comment"))
                    .child(hint("cmd-k", "commands")),
            );
        let markdown = |id: ElementId, text: String| {
            TextView::markdown(id, text)
                // shortcut: image previews stay in the web app until authenticated native image loading lands.
                .image_source(|_| ImageSource::from("velvet-preview-images-disabled"))
                .on_link_click(|url, _, _, cx| {
                    if let Some(url) = state::safe_external_url(url) {
                        cx.open_url(&url);
                    }
                })
        };
        let narrative = v_flex()
            .id("detail-scroll")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .px_6()
            .py_5()
            .gap_3()
            .child(
                h_flex()
                    .gap_2()
                    .text_size(px(13.))
                    .text_color(p.secondary)
                    .child(issue.key.clone())
                    .child("·")
                    .child(project),
            )
            .child(
                div()
                    .id("issue-heading")
                    .role(Role::Heading)
                    .aria_label(issue.title.clone())
                    .text_size(px(20.))
                    .line_height(relative(1.25))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(issue.title.clone()),
            )
            .when(narrow, |v| {
                v.child(
                    h_flex()
                        .flex_wrap()
                        .items_center()
                        .gap_2()
                        .child(self.status_menu(true, cx))
                        .child(self.label(format!(
                            "P{} · {}",
                            issue.priority,
                            self.project_name(issue)
                        ))),
                )
            })
            .child(
                div()
                    .id("issue-description")
                    .role(Role::Paragraph)
                    .aria_label(issue.description.clone())
                    // Readable measure, matching the web's 46rem Markdown width.
                    .max_w(px(640.))
                    .text_size(px(14.))
                    .child(markdown("description".into(), issue.description.clone())),
            )
            .child(
                h_flex()
                    .id("activity-heading")
                    .role(Role::Heading)
                    .aria_label("Activity")
                    .max_w(px(640.))
                    .mt_3()
                    .pt_4()
                    .gap_2()
                    .items_baseline()
                    .border_t_1()
                    .border_color(p.border)
                    .child(div().font_weight(FontWeight::SEMIBOLD).child("Activity"))
                    .child(div().text_size(px(13.)).text_color(p.muted).child(format!(
                        "{} update{}",
                        self.comments.len(),
                        if self.comments.len() == 1 { "" } else { "s" }
                    ))),
            )
            .when(self.detail_loading, |v| {
                v.child(self.label("Loading updates…"))
            })
            .when(self.comments.is_empty() && !self.detail_loading, |v| {
                v.child(self.label("No updates yet. Record your progress below."))
            })
            .children(self.comments.iter().enumerate().map(|(index, comment)| {
                let body = if comment.deleted_at.is_some() {
                    "Comment deleted.".to_owned()
                } else {
                    comment.body.clone()
                };
                h_flex()
                    .max_w(px(640.))
                    .gap_2p5()
                    .py_2()
                    .items_start()
                    .child(Avatar::new().name(author_label(comment)).xsmall())
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap_0p5()
                            .child(
                                h_flex()
                                    .gap_2()
                                    .items_baseline()
                                    .child(
                                        div()
                                            .id(("comment-author", index))
                                            .role(Role::Paragraph)
                                            .aria_label(author_label(comment))
                                            .test_support()
                                            .text_size(px(14.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .child(author_label(comment)),
                                    )
                                    .child(div().text_size(px(13.)).text_color(p.muted).child(
                                        comment.kind.clone().unwrap_or_else(|| "Comment".into()),
                                    )),
                            )
                            .child(
                                div()
                                    .id(("comment-body", index))
                                    .role(Role::Paragraph)
                                    .aria_label(body.clone())
                                    .test_support()
                                    .text_size(px(14.))
                                    .child(markdown(("comment", index).into(), body)),
                            ),
                    )
            }));
        // The composer stays pinned under the narrative so posting never needs a scroll.
        let composer = self.can_write().then(|| {
            v_flex()
                .flex_shrink_0()
                .border_t_1()
                .border_color(p.border)
                .child(
                    Textarea::new(&self.composer)
                        .appearance(false)
                        .aria_label("Progress update")
                        .disabled(self.saving)
                        .px_3()
                        .py_2()
                        .h(px(72.)),
                )
                .child(
                    h_flex()
                        .h(px(40.))
                        .px_3()
                        .justify_between()
                        .bg(p.surface)
                        .child(
                            h_flex()
                                .gap_1p5()
                                .text_size(px(13.))
                                .text_color(p.muted)
                                .child("Markdown ·")
                                .child(Kbd::new(Keystroke::parse("cmd-enter").unwrap()).outline())
                                .child("to post"),
                        )
                        .child(
                            Button::new("post")
                                .primary()
                                .small()
                                .label(if self.saving {
                                    "Saving…"
                                } else {
                                    "Post update"
                                })
                                .disabled(self.saving || self.detail_loading)
                                .on_click(cx.listener(|this, _, window, cx| this.post(window, cx))),
                        ),
                )
        });
        h_flex()
            .flex_1()
            .min_w_0()
            .h_full()
            .p_3()
            .gap_3()
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .rounded(px(14.))
                    .overflow_hidden()
                    .bg(p.card)
                    .border_t_1()
                    .border_color(p.edge)
                    .child(narrative)
                    .children(composer),
            )
            .when(!narrow, |v| v.child(rail))
            .into_any_element()
    }
    fn project_name(&self, issue: &Issue) -> String {
        issue
            .project_id
            .as_ref()
            .and_then(|id| self.projects.iter().find(|p| &p.id == id))
            .map(|p| p.name.clone())
            .unwrap_or_else(|| "Unfiled".into())
    }
    /// Display name for the assignee, or `None` when unassigned. An id the member
    /// list does not know still shows, abbreviated, like the web app.
    fn assignee_name(&self, issue: &Issue) -> Option<String> {
        let id = issue.assignee_id.as_ref()?;
        Some(
            self.members
                .iter()
                .find(|m| &m.id == id)
                .map(|m| m.user.label())
                .unwrap_or_else(|| format!("Member {}", &id[..id.len().min(8)])),
        )
    }
    fn now() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    }
    /// Three segments aligned with the panes below: sidebar, list actions, detail actions.
    fn toolbar(&self, window: &Window, cx: &Context<Self>) -> AnyElement {
        let p = self.palette();
        let narrow = window.viewport_size().width < px(1200.);
        let slug = self.slug().unwrap_or_default();
        let issue = (self.page.is_none() && !self.sprints_view)
            .then_some(self.selected.as_ref())
            .flatten();
        let title = if let Some(page) = self.page {
            page.title().to_owned()
        } else if self.sprints_view {
            "Sprints".to_owned()
        } else {
            "Issues".to_owned()
        };
        let icon_button = |id: &'static str, icon: Lucide, tip: &'static str| {
            Button::new(id)
                .ghost()
                .small()
                .icon(Icon::new(icon))
                .tooltip(tip)
                .accessibility_label(tip)
        };
        h_flex()
            .id("toolbar")
            .h(px(52.))
            .flex_shrink_0()
            .window_control_area(WindowControlArea::Drag)
            .on_mouse_down(MouseButton::Left, |_, window, _| start_window_move(window))
            .pr_3()
            .gap_3()
            .items_center()
            .child(
                // Traffic lights sit over this segment; the rest is a drag handle.
                h_flex().w(px(228.)).h_full().flex_shrink_0(),
            )
            .child(
                self.capsule(p, "glass-list")
                    .w(px(400.))
                    .flex_shrink_0()
                    .child(
                        div()
                            .id("view-heading")
                            .role(Role::Heading)
                            .aria_label(title.clone())
                            .test_support()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(title),
                    )
                    .child(
                        div()
                            .text_size(px(13.))
                            .text_color(p.muted)
                            .child(format!("{}", self.issues.len())),
                    )
                    .child(div().flex_1())
                    .child(
                        icon_button("refresh", Lucide::RefreshCw, "Refresh (⌘R)")
                            .disabled(self.loading)
                            .on_click(cx.listener(|this, _, _, cx| this.refresh(false, cx))),
                    )
                    .child(
                        Button::new("new")
                            .primary()
                            .small()
                            .icon(Icon::new(Lucide::Plus))
                            .label("New")
                            .tooltip("New issue (⌘N)")
                            .disabled(!self.can_write() || self.saving)
                            .on_click(
                                cx.listener(|this, _, window, cx| {
                                    this.open_form(false, window, cx)
                                }),
                            ),
                    ),
            )
            .child(
                self.capsule(p, "glass-detail")
                    .flex_1()
                    .min_w_0()
                    .when_some(issue, |bar, issue| {
                        let key = issue.key.clone();
                        bar.child(
                            h_flex()
                                .min_w_0()
                                .gap_2()
                                .text_size(px(14.))
                                .child(div().font_weight(FontWeight::SEMIBOLD).child(key.clone()))
                                .when(!narrow, |r| {
                                    r.child(
                                        h_flex()
                                            .ml_1()
                                            .h(px(22.))
                                            .px_2()
                                            .gap_1p5()
                                            .rounded_full()
                                            .border_t_1()
                                            .border_color(p.edge)
                                            .bg(p.glass)
                                            .text_size(px(13.))
                                            .child(status_icon(&issue.status, p).size(px(13.)))
                                            .child(status_label(&issue.status).to_owned()),
                                    )
                                }),
                        )
                        .child(div().flex_1())
                        .when(!narrow, |bar| {
                            bar.child(
                                icon_button("previous", Lucide::ChevronUp, "Previous issue (K)")
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.move_selection(-1, window, cx)
                                    })),
                            )
                            .child(
                                icon_button("next", Lucide::ChevronDown, "Next issue (J)")
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.move_selection(1, window, cx)
                                    })),
                            )
                            .child(div().w(px(1.)).h(px(18.)).mx_1().bg(p.hair))
                        })
                        .child(
                            Button::new("edit")
                                .ghost()
                                .small()
                                .icon(Icon::new(Lucide::SquarePen))
                                .label("Edit")
                                .tooltip("Edit issue (E)")
                                .disabled(!self.can_write() || self.saving)
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.open_form(true, window, cx)
                                })),
                        )
                        .child(
                            icon_button("open-web", Lucide::ExternalLink, "Open in web")
                                .when(self.demo, |b| b.tooltip("Not available for sample data"))
                                .disabled(self.demo)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.open_web(&format!("/w/{slug}/issues/{key}"), cx)
                                })),
                        )
                    }),
            )
            .into_any_element()
    }
    /// A floating glass capsule: the Liquid Glass unit for toolbar segments.
    fn capsule(&self, p: Palette, name: &'static str) -> Div {
        let el = h_flex()
            .h(px(36.))
            .px_3()
            .gap_1()
            .items_center()
            .rounded_full()
            .border_t_1()
            .border_color(p.edge)
            .shadow_sm();
        self.glass_backed(el, name, px(18.), false, p.glass_strong)
    }
    fn signed_out(&self, cx: &Context<Self>) -> AnyElement {
        let p = self.palette();
        v_flex().size_full()
            .child(div().h(px(44.)).w_full().flex_shrink_0().window_control_area(WindowControlArea::Drag)
            .on_mouse_down(MouseButton::Left, |_, window, _| start_window_move(window)))
            .child(v_flex().flex_1().items_center().justify_center().p_6().gap_4()
            .child(v_flex().w(px(460.)).max_w_full().gap_4().p_6().border_1().border_color(p.border).rounded(px(8.))
                .child(div().text_size(px(24.)).font_weight(FontWeight::SEMIBOLD).child("Velvet for macOS"))
                .child(self.label("Your issues and work journal, in a native workspace."))
                .child(div().child("Velvet server"))
                .child(Input::new(&self.server_input).aria_label("Velvet server").disabled(self.loading))
                .child(Button::new("sign-in").primary().label(if self.loading{"Waiting for browser…"}else{"Sign in with your browser"}).disabled(self.loading).on_click(cx.listener(|this,_,_,cx|this.sign_in(cx))))
                .when_some(self.login.as_ref(),|v,login|v.child(self.label("Compare this code in your browser:")).child(div().font_family("Menlo").text_size(px(24.)).child(login.user_code.clone())).child(self.label("Approve only if you started this sign-in. No repository credentials are reused.")))
                .when(self.loading,|v|v.child(Button::new("cancel-login").label("Cancel sign-in").disabled(self.saving).on_click(cx.listener(|this,_,_,cx|{if !this.saving{this.session_revision.next();this.loading=false;this.login=None;cx.notify();}}))))
                .child(Button::new("sample").ghost().label("Explore sample workspace").disabled(self.loading).on_click(cx.listener(|this,_,_,cx|{this.demo=true;this.seed_demo();cx.notify();})))
                .child(self.label(format!("Version {} · Credentials stay in macOS Keychain", update::CURRENT)))))
            .into_any_element()
    }
    fn overlay(&self, cx: &Context<Self>) -> AnyElement {
        let p = self.palette();
        let mut body = v_flex()
            .id("overlay-body")
            .role(Role::Dialog)
            .aria_label(if self.quit_prompt {
                "Quit confirmation"
            } else if self.confirm_logout {
                "Sign out confirmation"
            } else if self.editing {
                "Issue editor"
            } else {
                "Commands"
            })
            .test_support()
            .track_focus(&self.modal_focus)
            .w(px(540.))
            .max_w_full()
            .max_h_full()
            .overflow_y_scroll()
            .p_6()
            .gap_4()
            .bg(p.paper)
            .border_1()
            .border_color(p.border)
            .rounded(px(8.));
        if self.quit_prompt {
            body = body.child(div().text_size(px(24.)).child("Discard unsent drafts and quit?"))
                .child("Unsent drafts stay in this window only. Posted work is already saved on the server.")
                .child(gpui_kit::base::Button::new("cancel-quit").track_focus(&self.cancel_focus).accessibility_label("Keep working").child("Keep working").h(px(32.)).px_3().flex().items_center().justify_center().border_1().border_color(p.border).rounded(px(6.)).focus_visible(|style| style.border_2().border_color(p.ink)).on_click(cx.listener(|this, _, window, cx| this.close_overlay(window, cx))))
                .child(Button::new("confirm-quit").danger().label("Discard drafts and quit").on_click(cx.listener(|this, _, _, cx| this.finish_quit(cx))));
        } else if self.confirm_logout {
            body=body.child(div().text_size(px(24.)).child("Sign out of Velvet?"))
                .child("This revokes this desktop credential and clears this window’s private data and unsent drafts. Other clients remain signed in.")
                .child(gpui_kit::base::Button::new("cancel-logout").track_focus(&self.cancel_focus).accessibility_label("Cancel").child("Cancel").h(px(32.)).px_3().flex().items_center().justify_center().border_1().border_color(p.border).rounded(px(6.)).focus_visible(|style| style.border_2().border_color(p.ink)).disabled(self.saving).on_click(cx.listener(|this,_,window,cx|this.close_overlay(window,cx))))
                .child(Button::new("confirm-logout").danger().label(if self.saving{"Signing out…"}else{"Revoke access and sign out"}).disabled(self.saving).on_click(cx.listener(|this,_,window,cx|this.logout(window,cx))));
        } else if self.editing {
            body = body
                .child(
                    div()
                        .id("overlay-heading")
                        .role(Role::Heading)
                        .aria_label(if self.edit_key.is_some() {
                            "Edit issue"
                        } else {
                            "New issue"
                        })
                        .test_support()
                        .text_size(px(24.))
                        .child(if self.edit_key.is_some() {
                            "Edit issue"
                        } else {
                            "New issue"
                        }),
                )
                .child(self.label(format!("Organisation: {}", self.slug().unwrap_or_default())))
                .child("Title")
                .child(
                    Input::new(&self.title)
                        .aria_label("Issue title")
                        .disabled(self.saving),
                )
                .child("Description")
                .child(
                    Textarea::new(&self.description)
                        .aria_label("Issue description")
                        .disabled(self.saving)
                        .h(px(200.)),
                )
                .child(
                    h_flex()
                        .gap_2()
                        .child(
                            Button::new("cancel-edit")
                                .label("Close (keep draft)")
                                .disabled(self.saving)
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.close_overlay(window, cx)
                                })),
                        )
                        .child(
                            Button::new("save-issue")
                                .primary()
                                .label(if self.saving {
                                    "Saving…"
                                } else {
                                    "Save issue"
                                })
                                .disabled(self.saving)
                                .on_click(
                                    cx.listener(|this, _, window, cx| this.save_issue(window, cx)),
                                ),
                        ),
                );
        } else {
            let items = self.palette_items(cx);
            let active = self.palette_index.min(items.len().saturating_sub(1));
            body = body
                .p_0()
                .gap_0()
                .child(
                    h_flex()
                        .px_3()
                        .gap_2()
                        .border_b_1()
                        .border_color(p.border)
                        .child(Icon::new(Lucide::Search).size(px(16.)).text_color(p.muted))
                        .child(
                            Input::new(&self.palette)
                                .appearance(false)
                                .aria_label("Command or issue")
                                .h(px(48.)),
                        ),
                )
                .child(
                    v_flex()
                        .p_2()
                        .when(items.is_empty(), |v| {
                            v.child(
                                div()
                                    .p_3()
                                    .child(self.label("No matching commands or issues.")),
                            )
                        })
                        .children(items.into_iter().enumerate().map(|(row, item)| {
                            let (icon, text, hint) = match item {
                                PaletteItem::Action(_, keys, icon) => {
                                    (Some(icon), item.text(), keys)
                                }
                                PaletteItem::Go(_, _, icon) => (Some(icon), item.text(), None),
                                PaletteItem::Issue(index) => {
                                    let issue = &self.issues[index];
                                    (None, format!("{}  {}", issue.key, issue.title), None)
                                }
                            };
                            let status = match item {
                                PaletteItem::Issue(index) => {
                                    Some(self.issues[index].status.clone())
                                }
                                _ => None,
                            };
                            let disabled = matches!(item, PaletteItem::Action("New issue", ..))
                                && !self.can_write();
                            Button::new(("cmd", row))
                                .ghost()
                                .accessibility_label(text.clone())
                                .w_full()
                                .h(px(36.))
                                .px_2()
                                .justify_start()
                                .disabled(disabled)
                                .when(row == active, |b| b.bg(p.surface))
                                .child(
                                    h_flex()
                                        .w_full()
                                        .min_w_0()
                                        .gap_2()
                                        .when_some(icon, |r, icon| {
                                            r.child(
                                                Icon::new(icon)
                                                    .size(px(16.))
                                                    .text_color(p.secondary),
                                            )
                                        })
                                        .when_some(status, |r, s| r.child(status_icon(&s, p)))
                                        .child(div().flex_1().min_w_0().truncate().child(text))
                                        .when_some(hint, |r, keys| {
                                            r.child(Kbd::new(Keystroke::parse(keys).unwrap()))
                                        }),
                                )
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.run_palette_item(item, window, cx)
                                }))
                        })),
                )
                .child(
                    h_flex()
                        .px_3()
                        .py_2()
                        .gap_3()
                        .border_t_1()
                        .border_color(p.border)
                        .child(self.label("↑↓ to move · Enter to run · Esc to close")),
                );
            // Arrow keys and Enter belong to the result list, not the one-line query field.
            body = body.capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                if event.keystroke.modifiers.modified() {
                    return;
                }
                match event.keystroke.key.as_str() {
                    "up" => this.move_selection(-1, window, cx),
                    "down" => this.move_selection(1, window, cx),
                    "enter" => this.run_palette(window, cx),
                    _ => return,
                }
                cx.stop_propagation();
            }));
        }
        body = body.when_some(self.error.as_ref(), |body, error| {
            body.child(
                div()
                    .id("modal-error")
                    .role(Role::Alert)
                    .aria_label(error.clone())
                    .text_color(p.danger)
                    .child(error.clone()),
            )
        });
        div()
            .id("modal-backdrop")
            .occlude()
            .absolute()
            .inset_0()
            .bg(gpui_kit::black().opacity(0.35))
            .flex()
            .items_center()
            .justify_center()
            .p_6()
            .child(body.occlude().focus_trap("velvet-modal", &self.modal_focus))
            .into_any_element()
    }
}
impl Render for Velvet {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // Theme mode may change from the system while the window is open.
        self.dark = Theme::global(cx).mode.is_dark();
        if let Some(g) = &self.native_glass {
            g.begin_frame();
        }
        let p = self.palette();
        v_flex()
            .id("velvet-workspace")
            .role(Role::Main)
            .aria_label("Velvet workspace")
            .test_support()
            .relative()
            .size_full()
            // Translucent so the backdrop shows between the cards. With native
            // glass the system views sample the desktop, so the root paints a
            // lighter wash and the glass regions stay fully clear.
            .bg(match (&self.native_glass, self.glass) {
                (Some(_), true) => p.paper.opacity(0.3),
                (None, true) => p.paper.opacity(0.35),
                _ => p.paper,
            })
            .text_color(p.ink)
            .font_family(".AppleSystemUIFont")
            .text_size(px(16.))
            .track_focus(&self.focus)
            .key_context("Velvet")
            .capture_action(cx.listener(
                |this, _: &gpui_kit::base::input::IndentInline, window, cx| {
                    if this.composer.focus_handle(cx).is_focused(window)
                        || this.description.focus_handle(cx).is_focused(window)
                    {
                        window.focus_next(cx);
                        cx.stop_propagation();
                    } else {
                        cx.propagate();
                    }
                },
            ))
            .capture_action(cx.listener(
                |this, _: &gpui_kit::base::input::OutdentInline, window, cx| {
                    if this.composer.focus_handle(cx).is_focused(window)
                        || this.description.focus_handle(cx).is_focused(window)
                    {
                        window.focus_prev(cx);
                        cx.stop_propagation();
                    } else {
                        cx.propagate();
                    }
                },
            ))
            .on_action(cx.listener(|this, _: &Quit, window, cx| this.request_quit(window, cx)))
            .on_action(cx.listener(|this, _: &Commands, window, cx| this.open_commands(window, cx)))
            .on_action(
                cx.listener(|this, _: &NewIssue, window, cx| this.open_form(false, window, cx)),
            )
            .on_action(cx.listener(|this, _: &Refresh, _, cx| this.refresh(false, cx)))
            .on_action(
                cx.listener(|this, _: &NextIssue, window, cx| this.move_selection(1, window, cx)),
            )
            .on_action(cx.listener(|this, _: &PreviousIssue, window, cx| {
                this.move_selection(-1, window, cx)
            }))
            .on_action(cx.listener(|this, _: &PostUpdate, window, cx| this.post(window, cx)))
            .on_action(
                cx.listener(|this, _: &CheckForUpdates, _, cx| this.check_for_updates(true, cx)),
            )
            .on_action(cx.listener(|this, _: &ToggleAutoUpdate, _, cx| this.toggle_auto_update(cx)))
            // Single-key shortcuts, Linear style. Only when no field or overlay has focus.
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                if event.keystroke.modifiers.modified() || !this.list_keys_active(window, cx) {
                    return;
                }
                match event.keystroke.key.as_str() {
                    "j" => this.move_selection(1, window, cx),
                    "k" => this.move_selection(-1, window, cx),
                    "e" if this.selected.is_some() && this.can_write() => {
                        this.open_form(true, window, cx)
                    }
                    "c" if this.selected.is_some() && this.can_write() => {
                        this.composer.update(cx, |c, cx| c.focus(window, cx))
                    }
                    "s" if this.selected.is_some() => this.cycle_status(cx),
                    _ => return,
                }
                cx.stop_propagation();
            }))
            // The toolbar hosts the traffic lights, so it stays first; banners sit under it.
            .when(self.identity.is_some() && self.slug().is_some(), |v| {
                v.child(self.toolbar(window, cx))
            })
            .when_some(self.available_update.as_ref(), |v, manifest| {
                let ready = self.staged_update.is_some();
                let text = match (ready, manifest.notes.trim()) {
                    (true, _) => format!(
                        "Velvet {} is ready. It installs when you quit, or restart now.",
                        manifest.version
                    ),
                    (false, "") => format!("Velvet {} is available.", manifest.version),
                    (false, notes) => {
                        format!("Velvet {} is available: {notes}", manifest.version)
                    }
                };
                v.child(
                    h_flex()
                        .px_4()
                        .py_2()
                        .gap_3()
                        .bg(p.surface)
                        .child(
                            div()
                                .id("update-message")
                                .role(Role::Status)
                                .aria_label(text.clone())
                                .flex_1()
                                .child(text),
                        )
                        .child(
                            Button::new("install-update")
                                .primary()
                                .label(if self.updating {
                                    "Downloading…"
                                } else if ready {
                                    "Restart now"
                                } else {
                                    "Update"
                                })
                                .disabled(self.updating)
                                .on_click(cx.listener(|this, _, window, cx| {
                                    if this.staged_update.is_some() {
                                        this.restart_to_update(window, cx)
                                    } else {
                                        this.download_update(cx)
                                    }
                                })),
                        )
                        .child(
                            Button::new("dismiss-update")
                                .ghost()
                                .label("Later")
                                .disabled(self.updating)
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.available_update = None;
                                    cx.notify();
                                })),
                        ),
                )
            })
            .on_action(cx.listener(|this, _: &Dismiss, window, cx| this.close_overlay(window, cx)))
            .when(self.demo, |v| {
                v.child(
                    h_flex()
                        .h(px(28.))
                        .px_4()
                        .items_center()
                        .justify_center()
                        .bg(p.glass)
                        .border_b_1()
                        .border_color(p.hair)
                        .text_size(px(13.))
                        .text_color(p.secondary)
                        .child(format!(
                            "Sample data · No server writes · v{}",
                            update::CURRENT
                        )),
                )
            })
            .when_some(self.error.as_ref(), |v, error| {
                v.child(
                    h_flex()
                        .px_4()
                        .py_2()
                        .gap_3()
                        .bg(p.surface)
                        .text_color(p.danger)
                        .child(
                            div()
                                .id("error-message")
                                .test_support()
                                .role(Role::Alert)
                                .aria_label(error.clone())
                                .flex_1()
                                .child(error.clone()),
                        )
                        .child(
                            Button::new("dismiss-error")
                                .ghost()
                                .label("Dismiss")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.error = None;
                                    cx.notify();
                                })),
                        ),
                )
            })
            .when_some(self.notice.as_ref(), |v, notice| {
                v.child(
                    h_flex()
                        .px_4()
                        .py_2()
                        .gap_3()
                        .bg(p.surface)
                        .child(
                            div()
                                .id("status-message")
                                .test_support()
                                .role(Role::Status)
                                .aria_label(notice.clone())
                                .flex_1()
                                .child(notice.clone()),
                        )
                        .child(
                            Button::new("dismiss-notice")
                                .ghost()
                                .label("Dismiss")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.notice = None;
                                    cx.notify();
                                })),
                        ),
                )
            })
            .child(if self.identity.is_none() {
                self.signed_out(cx)
            } else if self.slug().is_none() {
                v_flex()
                    .child(
                        div()
                            .h(px(44.))
                            .w_full()
                            .window_control_area(WindowControlArea::Drag)
                            .on_mouse_down(MouseButton::Left, |_, window, _| {
                                start_window_move(window)
                            }),
                    )
                    .p_6()
                    .gap_4()
                    .child("No organisations yet.")
                    .child("Create or join an organisation in Velvet, then sign in again.")
                    .child(
                        Button::new("onboarding").label("Open Velvet ↗").on_click(
                            cx.listener(|this, _, _, cx| this.open_web("/onboarding", cx)),
                        ),
                    )
                    .child(Button::new("empty-logout").label("Sign out…").on_click(
                        cx.listener(|this, _, window, cx| this.confirm_sign_out(window, cx)),
                    ))
                    .into_any_element()
            } else {
                h_flex()
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .child(self.sidebar(cx))
                    .when_some(self.page, |v, page| v.child(self.page_view(page, cx)))
                    .when(self.page.is_none() && self.sprints_view, |v| {
                        v.child(self.sprint_list(cx)).child(self.sprint_board(cx))
                    })
                    .when(self.page.is_none() && !self.sprints_view, |v| {
                        v.child(self.issue_list(cx)).child(self.detail(window, cx))
                    })
                    .into_any_element()
            })
            .when(
                self.commands || self.editing || self.confirm_logout || self.quit_prompt,
                |v| v.child(self.overlay(cx)),
            )
    }
}
