use crate::{
    api::{ApiClient, Comment, DeviceSession, Identity, Issue, Project},
    credentials,
    state::{self, Revision, STATUSES, status_label},
    theme::{self, Palette},
};
use gpui_kit::base::{FocusTrapElement, TestSupportExt, text::TextView};
use gpui_kit::component::menu::{DropdownMenu, PopupMenuItem};
use gpui_kit::component::{
    button::{Button, ButtonVariants},
    input::{Input, InputEvent, InputState, Textarea, TextareaState},
    *,
};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
#[cfg(all(test, feature = "ui-tests"))]
#[path = "ui_tests.rs"]
mod ui_tests;

use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

pub const DEFAULT_SERVER: &str = "https://velvet.sabarinarayana.com";
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
        PostUpdate
    ]
);

pub struct Velvet {
    server: String,
    demo: bool,
    dark: bool,
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
    project: Option<String>,
    status: Option<String>,
    issues: Vec<Issue>,
    selected: Option<Issue>,
    comments: Vec<Comment>,
    next_cursor: Option<String>,
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
    editing: bool,
    edit_key: Option<String>,
    confirm_logout: bool,
    quit_prompt: bool,
    quitting: bool,
    _subscriptions: Vec<Subscription>,
}

impl Velvet {
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
        let mut this = Self {
            server,
            demo,
            dark,
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
            project: None,
            status: None,
            issues: vec![],
            selected: None,
            comments: vec![],
            next_cursor: None,
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
            editing: false,
            edit_key: None,
            confirm_logout: false,
            quit_prompt: false,
            quitting: false,
            _subscriptions: subscriptions,
        };
        if demo {
            this.seed_demo();
        } else {
            this.restore(cx);
        }
        this
    }

    pub fn is_quitting(&self) -> bool {
        self.quitting
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
            self.quitting = true;
            cx.quit();
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
        let cursor = if more { self.next_cursor.clone() } else { None };
        let session = self.session_revision.current();
        let revision = self.list_revision.next();
        self.loading = true;
        self.error = None;
        cx.spawn(async move |view, cx| {
            let result = smol::unblock(move || -> anyhow::Result<_> {
                Ok((
                    client.projects(&slug)?,
                    client.issues_page(&slug, None, None, cursor.as_deref())?,
                ))
            })
            .await;
            let _ = view.update(cx, |this, cx| {
                if !this.session_revision.accepts(session) || !this.list_revision.accepts(revision)
                {
                    return;
                }
                this.loading = false;
                match result {
                    Ok((projects, page)) => {
                        this.projects = projects;
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
                Ok((
                    client.issue(&slug, &issue.key)?,
                    client.comments(&slug, &issue.key)?,
                ))
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
                    Ok((issue, comments)) => {
                        this.selected = Some(issue);
                        this.comments = comments;
                    }
                    Err(e) => this.error = Some(e.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
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
        self.selected = None;
        self.comments.clear();
        self.next_cursor = None;
        self.detail_loading = false;
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
        if edit && issue.is_none() {
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
        window.focus(&self.modal_focus, cx);
        cx.notify();
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
        let project = self.project.clone();
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
        cx.spawn(async move |view, cx| {
            let result =
                smol::unblock(move || client.update_status(&slug, &issue.key, &status)).await;
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
                        this.notice = Some("Status saved.".into());
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
                        this.selected = None;
                        this.comments.clear();
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
        if self.commands || self.editing || self.confirm_logout || self.quit_prompt {
            return;
        }
        let indices = state::matching_indices(
            &self.issues,
            &self.search.read(cx).value(),
            self.project.as_deref(),
            self.status.as_deref(),
        );
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
    fn seed_demo(&mut self) {
        self.identity=serde_json::from_value(serde_json::json!({"token_kind":"desktop","user":{"id":"sample","name":"Sabari","email":"Sample account"},"memberships":[{"id":"sample","workspace_id":"sample","workspace_slug":"velvet","workspace_name":"Velvet","issue_prefix":"VEL","role":"member"}]})).ok();
        self.projects=serde_json::from_value(serde_json::json!([{"id":"desktop","key":"desktop","name":"Desktop","status":"active"}])).unwrap_or_default();
        self.issues=[("Build the native workspace shell","in_progress"),("Add browser sign-in","todo"),("Connect issue details","todo"),("Write a work log","backlog"),("Add keyboard navigation","todo"),("Package the macOS app","done")].into_iter().enumerate().map(|(i,(title,status))|Issue{id:format!("sample-{i}"),key:format!("VEL-{}",142+i),title:title.into(),description:"Bring issues, project context, and work logs into one native workspace.\n\nKeep the interface fast, quiet, and keyboard-first.\n\n### Checklist\n- [x] Workspace switcher\n- [x] Issue list and detail\n- [ ] Command palette\n\nThis is **sample data**, not your project’s current work.".into(),status:status.into(),priority:2,project_id:Some("desktop".into()),..Default::default()}).collect();
        self.selected = self.issues.first().cloned();
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
            .text_color(Palette::new(self.dark).muted)
            .child(text)
    }
    fn workspace_menu(&self, cx: &Context<Self>) -> AnyElement {
        let memberships = self
            .identity
            .as_ref()
            .map(|i| i.memberships.clone())
            .unwrap_or_default();
        let label = memberships
            .get(self.workspace)
            .map(|w| format!("{}  ⇅", w.workspace_name))
            .unwrap_or_else(|| "Velvet".into());
        let view = cx.entity().downgrade();
        Button::new("workspace")
            .ghost()
            .label(label)
            .w_full()
            .h(px(44.))
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
            .label(label)
            // Advertise accessibility Press; the dropdown opens on mouse-down.
            .on_click(|_, _, _| {})
            .dropdown_menu(move |mut menu, _, _| {
                for (id, name) in &choices {
                    let id = id.clone();
                    let view = view.clone();
                    menu = menu.item(PopupMenuItem::new(name.clone()).on_click(move |_, _, cx| {
                        let _ = view.update(cx, |this, cx| {
                            this.project = id.clone();
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
        Button::new(if mutation {
            "issue-status"
        } else {
            "status-filter"
        })
        .label(label)
        .disabled(mutation && (!self.can_write() || self.saving || self.detail_loading))
        // Advertise accessibility Press; the dropdown opens on mouse-down.
        .on_click(|_, _, _| {})
        .dropdown_menu(move |mut menu, _, _| {
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
                menu = menu.item(PopupMenuItem::new(status_label(status)).on_click(
                    move |_, _, cx| {
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
                    },
                ));
            }
            menu
        })
        .into_any_element()
    }
    fn sidebar(&self, cx: &Context<Self>) -> AnyElement {
        let p = Palette::new(self.dark);
        let workspace = self
            .identity
            .as_ref()
            .and_then(|i| i.memberships.get(self.workspace));
        let slug = self.slug().unwrap_or_default();
        let nav = [
            ("Dashboard", ""),
            ("Issues", "issues"),
            ("Projects", "projects"),
            ("Sprints", "sprints"),
            ("Reports", "reports"),
            ("Team feed", "feed"),
            ("Mentions", "mentions"),
            ("Unlinked PRs", "unlinked"),
        ];
        v_flex()
            .w(px(220.))
            .h_full()
            .flex_shrink_0()
            .p_3()
            .gap_2()
            .bg(p.surface)
            .border_r_1()
            .border_color(p.border)
            .child(self.workspace_menu(cx))
            .child(
                self.label(
                    workspace
                        .map(|w| format!("{} access", w.role))
                        .unwrap_or_default(),
                ),
            )
            .child(
                Button::new("commands")
                    .label("Search commands   ⌘K")
                    .w_full()
                    .on_click(cx.listener(|this, _, window, cx| this.open_commands(window, cx))),
            )
            .child(div().mt_4().mb_1().child(self.label("Workspace")))
            .children(nav.into_iter().map(|(label, path)| {
                let slug = slug.clone();
                Button::new(SharedString::from(format!("nav-{path}")))
                    .ghost()
                    .label(if path == "issues" {
                        label.to_owned()
                    } else {
                        format!("{label}  ↗")
                    })
                    .w_full()
                    .justify_start()
                    .h(px(36.))
                    .when(path == "issues", |b| {
                        b.bg(p.paper).border_1().border_color(p.border)
                    })
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if path == "issues" {
                            this.commands = false;
                            cx.notify();
                        } else {
                            this.open_web(
                                &if path.is_empty() {
                                    format!("/w/{slug}")
                                } else {
                                    format!("/w/{slug}/{path}")
                                },
                                cx,
                            );
                        }
                    }))
            }))
            .child(div().flex_1())
            .child(
                Button::new("worklog")
                    .ghost()
                    .label("My work log  ↗")
                    .w_full()
                    .justify_start()
                    .on_click(cx.listener(|this, _, _, cx| this.open_web("/me/worklog", cx))),
            )
            .child(
                Button::new("theme")
                    .ghost()
                    .label(if self.dark {
                        "Light appearance"
                    } else {
                        "Dark appearance"
                    })
                    .w_full()
                    .justify_start()
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.dark = !this.dark;
                        theme::apply(this.dark, cx);
                        cx.notify();
                    })),
            )
            .child(
                div().border_t_1().border_color(p.border).pt_3().child(
                    self.identity
                        .as_ref()
                        .map(|i| i.user.name.clone())
                        .unwrap_or_default(),
                ),
            )
            .child(
                Button::new("logout")
                    .ghost()
                    .label(if self.demo {
                        "Exit sample preview"
                    } else {
                        "Sign out…"
                    })
                    .w_full()
                    .justify_start()
                    .on_click(cx.listener(|this, _, window, cx| {
                        if this.demo {
                            this.demo = false;
                            this.identity = None;
                            this.issues.clear();
                            this.selected = None;
                        } else {
                            this.confirm_sign_out(window, cx);
                        }
                        cx.notify();
                    })),
            )
            .into_any_element()
    }
    fn issue_list(&self, cx: &Context<Self>) -> AnyElement {
        let p = Palette::new(self.dark);
        let indices = state::matching_indices(
            &self.issues,
            &self.search.read(cx).value(),
            self.project.as_deref(),
            self.status.as_deref(),
        );
        let view = cx.entity().downgrade();
        let count = indices.len();
        let rows =
            uniform_list("issue-list", count, move |range, _, cx| {
                view.update(cx, |this, cx| {
                    range
                        .map(|row| {
                            let index = indices[row];
                            let issue = this.issues[index].clone();
                            let p = Palette::new(this.dark);
                            let selected = this.selected.as_ref().is_some_and(|s| s.id == issue.id);
                            Button::new(("issue", index))
                                .ghost()
                                .accessibility_label(format!(
                                    "{}: {}, {}{}",
                                    issue.key,
                                    issue.title,
                                    status_label(&issue.status),
                                    if selected { ", selected" } else { "" }
                                ))
                                .w_full()
                                .h(px(96.))
                                .justify_start()
                                .px_3()
                                .rounded_none()
                                .when(selected, |b| b.bg(p.surface))
                                .border_b_1()
                                .border_color(p.border)
                                .child(
                                    v_flex()
                                        .gap_1()
                                        .w_full()
                                        .min_w_0()
                                        .child(h_flex().gap_2().child(this.label(issue.key)).child(
                                            this.label(status_label(&issue.status).to_owned()),
                                        ))
                                        .child(
                                            div()
                                                .text_size(px(16.))
                                                .whitespace_normal()
                                                .line_clamp(2)
                                                .child(issue.title),
                                        ),
                                )
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.select_issue(index, window, cx)
                                }))
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
            })
            .h_full()
            .w_full();
        v_flex()
            .w(px(340.))
            .h_full()
            .flex_shrink_0()
            .border_r_1()
            .border_color(p.border)
            .child(
                v_flex()
                    .p_4()
                    .gap_3()
                    .child(
                        h_flex()
                            .justify_between()
                            .child(
                                div()
                                    .text_size(px(24.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child("Issues"),
                            )
                            .child(
                                Button::new("new")
                                    .primary()
                                    .label("+ New")
                                    .disabled(!self.can_write() || self.saving)
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.open_form(false, window, cx)
                                    })),
                            ),
                    )
                    .child(Input::new(&self.search).aria_label("Search loaded issues"))
                    .child(
                        h_flex()
                            .gap_2()
                            .child(self.project_menu(cx))
                            .child(self.status_menu(false, cx)),
                    )
                    .child(
                        h_flex()
                            .justify_between()
                            .child(
                                self.label(format!("{count} shown · {} loaded", self.issues.len())),
                            )
                            .child(
                                Button::new("refresh")
                                    .ghost()
                                    .label("Refresh")
                                    .disabled(self.loading)
                                    .on_click(
                                        cx.listener(|this, _, _, cx| this.refresh(false, cx)),
                                    ),
                            ),
                    ),
            )
            .when(self.loading, |v| {
                v.child(div().p_3().child(self.label("Loading issues…")))
            })
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .when(count > 0, |v| v.child(rows))
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
                        .on_click(cx.listener(|this, _, _, cx| this.refresh(true, cx))),
                )
            })
            .into_any_element()
    }
    fn detail(&self, window: &Window, cx: &Context<Self>) -> AnyElement {
        let p = Palette::new(self.dark);
        let Some(issue) = self.selected.as_ref() else {
            return v_flex()
                .flex_1()
                .p_6()
                .gap_3()
                .child(div().text_size(px(24.)).child("Your work, in focus."))
                .child(self.label("Choose an issue to see its description and updates."))
                .into_any_element();
        };
        let slug = self.slug().unwrap_or_default();
        let key = issue.key.clone();
        let narrow = window.viewport_size().width < px(1200.);
        let metadata = v_flex()
            .w(if narrow { px(0.) } else { px(220.) })
            .when(!narrow, |v| v.p_4().border_l_1().border_color(p.border))
            .gap_3()
            .when(!narrow, |v| {
                v.child(self.label("Status"))
                    .child(self.status_menu(true, cx))
                    .child(div().mt_4().child(self.label("Priority")))
                    .child(format!("P{}", issue.priority))
                    .child(div().mt_4().child(self.label("Project")))
                    .child(
                        issue
                            .project_id
                            .as_ref()
                            .and_then(|id| self.projects.iter().find(|p| &p.id == id))
                            .map(|p| p.name.clone())
                            .unwrap_or_else(|| "Unfiled".into()),
                    )
                    .child(self.label("Other metadata and evidence are available in the web app."))
            });
        let description = TextView::markdown("description", issue.description.clone())
            // shortcut: image previews stay in the web app until authenticated native image loading lands.
            .image_source(|_| ImageSource::from("velvet-preview-images-disabled"))
            .on_link_click(|url, _, _, cx| {
                if let Some(url) = state::safe_external_url(url) {
                    cx.open_url(&url);
                }
            });
        h_flex()
            .flex_1()
            .min_w_0()
            .h_full()
            .items_start()
            .child(
                v_flex()
                    .id("detail-scroll")
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .overflow_y_scroll()
                    .p_6()
                    .gap_4()
                    .child(
                        h_flex()
                            .justify_between()
                            .gap_2()
                            .child(self.label(issue.key.clone()))
                            .child(
                                h_flex()
                                    .gap_2()
                                    .child(
                                        Button::new("edit")
                                            .ghost()
                                            .label("Edit")
                                            .disabled(!self.can_write() || self.saving)
                                            .on_click(cx.listener(|this, _, window, cx| {
                                                this.open_form(true, window, cx)
                                            })),
                                    )
                                    .child(
                                        Button::new("open-web")
                                            .ghost()
                                            .label("Open in web ↗")
                                            .disabled(self.demo)
                                            .on_click(cx.listener(move |this, _, _, cx| {
                                                this.open_web(
                                                    &format!("/w/{slug}/issues/{key}"),
                                                    cx,
                                                )
                                            })),
                                    ),
                            ),
                    )
                    .child(
                        div()
                            .id("issue-heading")
                            .role(Role::Heading)
                            .aria_label(issue.title.clone())
                            .text_size(px(24.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(issue.title.clone()),
                    )
                    .when(narrow, |v| {
                        v.child(
                            h_flex()
                                .flex_wrap()
                                .gap_2()
                                .child(self.label(format!(
                                    "{} · P{}",
                                    status_label(&issue.status),
                                    issue.priority
                                )))
                                .child(self.status_menu(true, cx)),
                        )
                    })
                    .child(
                        div()
                            .id("issue-description")
                            .role(Role::Paragraph)
                            .aria_label(issue.description.clone())
                            .child(description),
                    )
                    .child(
                        div()
                            .border_t_1()
                            .border_color(p.border)
                            .pt_4()
                            .font_weight(FontWeight::MEDIUM)
                            .child("Activity"),
                    )
                    .when(self.detail_loading, |v| {
                        v.child(self.label("Loading updates…"))
                    })
                    .when(self.comments.is_empty() && !self.detail_loading, |v| {
                        v.child(self.label("No updates yet. Record your progress below."))
                    })
                    .children(self.comments.iter().enumerate().map(|(index, comment)| {
                        v_flex()
                            .gap_2()
                            .py_3()
                            .border_b_1()
                            .border_color(p.border)
                            .child(
                                h_flex()
                                    .justify_between()
                                    .gap_2()
                                    .child(
                                        div()
                                            .id(("comment-author", index))
                                            .role(Role::Paragraph)
                                            .aria_label(comment.author.name.clone())
                                            .test_support()
                                            .child(comment.author.name.clone()),
                                    )
                                    .child(self.label(
                                        comment.kind.clone().unwrap_or_else(|| "Comment".into()),
                                    )),
                            )
                            .child(
                                div()
                                    .id(("comment-body", index))
                                    .role(Role::Paragraph)
                                    .aria_label(if comment.deleted_at.is_some() {
                                        "Comment deleted.".to_owned()
                                    } else {
                                        comment.body.clone()
                                    })
                                    .test_support()
                                    .child(
                                        TextView::markdown(
                                            ("comment", index),
                                            if comment.deleted_at.is_some() {
                                                "Comment deleted.".into()
                                            } else {
                                                comment.body.clone()
                                            },
                                        )
                                        .image_source(|_| {
                                            ImageSource::from("velvet-preview-images-disabled")
                                        })
                                        .on_link_click(
                                            |url, _, _, cx| {
                                                if let Some(url) = state::safe_external_url(url) {
                                                    cx.open_url(&url);
                                                }
                                            },
                                        ),
                                    ),
                            )
                    }))
                    .when(self.can_write(), |v| {
                        v.child(
                            v_flex()
                                .gap_2()
                                .mt_4()
                                .child(self.label("Progress update"))
                                .child(
                                    Textarea::new(&self.composer)
                                        .aria_label("Progress update")
                                        .disabled(self.saving)
                                        .h(px(110.)),
                                )
                                .child(
                                    h_flex()
                                        .justify_between()
                                        .child(self.label("Markdown · ⌘Enter to post"))
                                        .child(
                                            Button::new("post")
                                                .primary()
                                                .label(if self.saving {
                                                    "Saving…"
                                                } else {
                                                    "Post update"
                                                })
                                                .disabled(self.saving || self.detail_loading)
                                                .on_click(cx.listener(|this, _, window, cx| {
                                                    this.post(window, cx)
                                                })),
                                        ),
                                ),
                        )
                    })
                    .child(self.label(if self.demo {
                        "Sample data · Read-only design preview"
                    } else {
                        "GitHub evidence never changes issue status automatically."
                    })),
            )
            .child(metadata)
            .into_any_element()
    }
    fn signed_out(&self, cx: &Context<Self>) -> AnyElement {
        let p = Palette::new(self.dark);
        v_flex().size_full().items_center().justify_center().p_6().gap_4()
            .child(v_flex().w(px(460.)).max_w_full().gap_4().p_6().border_1().border_color(p.border).rounded(px(8.))
                .child(div().text_size(px(24.)).font_weight(FontWeight::SEMIBOLD).child("Velvet for macOS"))
                .child(self.label("Your issues and work journal, in a native workspace."))
                .child(div().child("Velvet server"))
                .child(Input::new(&self.server_input).aria_label("Velvet server").disabled(self.loading))
                .child(Button::new("sign-in").primary().label(if self.loading{"Waiting for browser…"}else{"Sign in with your browser"}).disabled(self.loading).on_click(cx.listener(|this,_,_,cx|this.sign_in(cx))))
                .when_some(self.login.as_ref(),|v,login|v.child(self.label("Compare this code in your browser:")).child(div().font_family("Menlo").text_size(px(24.)).child(login.user_code.clone())).child(self.label("Approve only if you started this sign-in. No repository credentials are reused.")))
                .when(self.loading,|v|v.child(Button::new("cancel-login").label("Cancel sign-in").disabled(self.saving).on_click(cx.listener(|this,_,_,cx|{if !this.saving{this.session_revision.next();this.loading=false;this.login=None;cx.notify();}}))))
                .child(Button::new("sample").ghost().label("Explore sample workspace").disabled(self.loading).on_click(cx.listener(|this,_,_,cx|{this.demo=true;this.seed_demo();cx.notify();})))
                .child(self.label("Online-first preview · Credentials stay in macOS Keychain")))
            .into_any_element()
    }
    fn overlay(&self, cx: &Context<Self>) -> AnyElement {
        let p = Palette::new(self.dark);
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
                .child("Preview drafts stay in this window only. Posted work is already saved on the server.")
                .child(gpui_kit::base::Button::new("cancel-quit").track_focus(&self.cancel_focus).accessibility_label("Keep working").child("Keep working").h(px(32.)).px_3().flex().items_center().justify_center().border_1().border_color(p.border).rounded(px(6.)).focus_visible(|style| style.border_2().border_color(p.ink)).on_click(cx.listener(|this, _, window, cx| this.close_overlay(window, cx))))
                .child(Button::new("confirm-quit").danger().label("Discard drafts and quit").on_click(cx.listener(|this, _, _, cx| { this.quitting = true; cx.quit(); })));
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
            body = body
                .child(div().text_size(px(24.)).child("Commands"))
                .child(
                    Button::new("cmd-search")
                        .ghost()
                        .label("Search issues")
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.commands = false;
                            this.search.update(cx, |s, cx| s.focus(window, cx));
                            cx.notify();
                        })),
                )
                .child(
                    Button::new("cmd-new")
                        .ghost()
                        .label("New issue   ⌘N")
                        .disabled(!self.can_write())
                        .on_click(
                            cx.listener(|this, _, window, cx| this.open_form(false, window, cx)),
                        ),
                )
                .child(
                    Button::new("cmd-refresh")
                        .ghost()
                        .label("Refresh issues   ⌘R")
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.close_overlay(window, cx);
                            this.refresh(false, cx);
                        })),
                )
                .child(
                    Button::new("cmd-close").label("Close   Escape").on_click(
                        cx.listener(|this, _, window, cx| this.close_overlay(window, cx)),
                    ),
                );
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
        let p = Palette::new(self.dark);
        v_flex()
            .id("velvet-workspace")
            .role(Role::Main)
            .aria_label("Velvet workspace")
            .test_support()
            .relative()
            .size_full()
            .bg(p.paper)
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
            .on_action(cx.listener(|this, _: &Dismiss, window, cx| this.close_overlay(window, cx)))
            .when(self.demo, |v| {
                v.child(
                    h_flex()
                        .h(px(32.))
                        .px_4()
                        .items_center()
                        .justify_center()
                        .bg(p.surface)
                        .child(self.label("Design preview · Sample data · No server writes")),
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
                    .child(self.issue_list(cx))
                    .child(self.detail(window, cx))
                    .into_any_element()
            })
            .when(
                self.commands || self.editing || self.confirm_logout || self.quit_prompt,
                |v| v.child(self.overlay(cx)),
            )
    }
}
