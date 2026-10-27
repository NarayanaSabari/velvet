//! Real headless rendering and interaction checks. These inspect native elements, not pixel screenshots.
use super::{DEFAULT_SERVER, Dismiss, PostUpdate, Quit, Velvet};
use gpui_kit::test::TestWindowExt;
use gpui_kit::{
    AnyWindowHandle, AppContext, Bounds, Entity, Focusable, KeyBinding, TestAppContext,
    WindowBounds, WindowOptions, point, px, size,
};

fn demo(cx: &mut TestAppContext, width: f32) -> (AnyWindowHandle, Entity<Velvet>) {
    cx.update(|cx| {
        gpui_kit::init(cx);
        cx.bind_keys([
            KeyBinding::new("cmd-q", Quit, None),
            KeyBinding::new("escape", Dismiss, Some("Velvet")),
            KeyBinding::new("cmd-enter", PostUpdate, Some("Velvet")),
        ]);
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds {
                    origin: point(px(0.), px(0.)),
                    size: size(px(width), px(900.)),
                })),
                ..Default::default()
            },
            cx,
            |window, cx| {
                let view = cx.new(|cx| Velvet::new(DEFAULT_SERVER.into(), true, window, cx));
                window.focus(&view.focus_handle(cx), cx);
                view
            },
        )
        .unwrap()
    })
}

#[gpui_kit::test]
fn native_fields_keep_accessible_names_when_values_change(cx: &mut TestAppContext) {
    let (window, view) = demo(cx, 1280.);
    window
        .update(cx, |_, window, cx| {
            window.render_frame(cx);
            let search_id = ("input", view.read(cx).search.entity_id());
            let composer_id = ("input", view.read(cx).composer.entity_id());
            assert_eq!(
                window.find(search_id.clone()).label(),
                Some("Search loaded issues")
            );
            assert_eq!(
                window.find(composer_id.clone()).label(),
                Some("Progress update")
            );
            assert_eq!(
                window.find(search_id).role(),
                Some(gpui_kit::Role::TextInput)
            );
            assert_eq!(
                window.find(composer_id.clone()).role(),
                Some(gpui_kit::Role::MultilineTextInput)
            );
            view.update(cx, |this, cx| {
                this.composer.update(cx, |input, cx| {
                    input.set_value("Private progress draft", window, cx)
                });
            });
            window.render_frame(cx);
            assert_eq!(
                window.find(composer_id.clone()).label(),
                Some("Progress update")
            );
            assert_eq!(
                window.find(composer_id).value(),
                Some("Private progress draft")
            );
            window.click("new", cx);
            let title_id = ("input", view.read(cx).title.entity_id());
            let description_id = ("input", view.read(cx).description.entity_id());
            assert_eq!(window.find(title_id.clone()).label(), Some("Issue title"));
            assert_eq!(
                window.find(description_id).label(),
                Some("Issue description")
            );
            window.input("Named field stays named", cx);
            assert_eq!(window.find(title_id.clone()).label(), Some("Issue title"));
            assert_eq!(
                window.find(title_id).value(),
                Some("Named field stays named")
            );
            view.update(cx, |this, cx| {
                this.close_overlay(window, cx);
                this.identity = None;
                cx.notify();
            });
            window.render_frame(cx);
            let server_id = ("input", view.read(cx).server_input.entity_id());
            assert_eq!(window.find(server_id).label(), Some("Velvet server"));
            assert!(view.read(cx).client.is_none());
        })
        .unwrap();
}

#[gpui_kit::test]
fn issue_selection_is_named_and_updates_without_resizing(cx: &mut TestAppContext) {
    let (window, _) = demo(cx, 1280.);
    window
        .update(cx, |_, window, cx| {
            window.render_frame(cx);
            for selected in 0..2usize {
                if selected == 1 {
                    window.click(("issue", selected), cx);
                }
                for index in 0..2usize {
                    let label = window.find(("issue", index)).label().unwrap().to_owned();
                    assert_eq!(label.ends_with(", selected"), index == selected, "{label}");
                }
            }
        })
        .unwrap();
}

#[gpui_kit::test]
fn native_buttons_support_tab_enter_and_space_without_pointer_input(cx: &mut TestAppContext) {
    let (window, view) = demo(cx, 1280.);
    window
        .update(cx, |_, window, cx| {
            window.render_frame(cx);
            for _ in 0..40 {
                if window.find("new").focused() == Some(true) {
                    break;
                }
                window.press("tab", cx);
            }
            assert_eq!(window.find("new").focused(), Some(true));
            assert_eq!(window.find("new").role(), Some(gpui_kit::Role::Button));
            window.press("enter", cx);
            assert!(view.read(cx).editing);
            assert!(view.read(cx).title.focus_handle(cx).is_focused(window));
            for _ in 0..12 {
                if window.find("cancel-edit").focused() == Some(true) {
                    break;
                }
                window.press("tab", cx);
            }
            assert_eq!(window.find("cancel-edit").focused(), Some(true));
            window.press("space", cx);
            assert!(!view.read(cx).editing);
            assert_eq!(window.find("new").focused(), Some(true));
        })
        .unwrap();
}

#[gpui_kit::test]
fn composer_tab_navigation_does_not_change_private_draft(cx: &mut TestAppContext) {
    let (window, view) = demo(cx, 1280.);
    window
        .update(cx, |_, window, cx| {
            window.render_frame(cx);
            view.update(cx, |this, cx| {
                this.composer.update(cx, |input, cx| {
                    input.set_value("Keep this draft exact", window, cx);
                    input.focus(window, cx);
                });
            });
            window.render_frame(cx);
            window.press("tab", cx);
            assert_eq!(window.find("post").focused(), Some(true));
            window.press("shift-tab", cx);
            assert!(view.read(cx).composer.focus_handle(cx).is_focused(window));
            window.press("shift-tab", cx);
            assert!(!view.read(cx).composer.focus_handle(cx).is_focused(window));
            assert_eq!(
                view.read(cx).composer.read(cx).value().as_ref(),
                "Keep this draft exact"
            );
        })
        .unwrap();
}

#[gpui_kit::test]
fn dropdowns_open_with_enter_and_space_and_escape_dismisses(cx: &mut TestAppContext) {
    let (window, _) = demo(cx, 1280.);
    for trigger in [
        "workspace",
        "project-filter",
        "status-filter",
        "issue-status",
    ] {
        for key in ["enter", "space"] {
            window
                .update(cx, |_, window, cx| {
                    window.render_frame(cx);
                    for _ in 0..60 {
                        if window.find(trigger).focused() == Some(true) {
                            break;
                        }
                        window.press("tab", cx);
                    }
                    assert_eq!(window.find(trigger).focused(), Some(true), "{trigger}");
                    window.press(key, cx);
                })
                .unwrap();
            window
                .update(cx, |_, window, cx| {
                    window.render_frame(cx);
                    assert_eq!(window.find("popup-menu").role(), Some(gpui_kit::Role::Menu));
                    window.press("escape", cx);
                })
                .unwrap();
            window
                .update(cx, |_, window, cx| {
                    window.render_frame(cx);
                    assert!(window.try_find("popup-menu").is_none());
                })
                .unwrap();
        }
    }
}

#[gpui_kit::test]
fn native_semantics_expose_workspace_comment_text_and_modal_heading(cx: &mut TestAppContext) {
    let (window, view) = demo(cx, 1280.);
    window
        .update(cx, |_, window, cx| {
            view.update(cx, |this, cx| {
                let comment = crate::api::Comment {
                    id: "accessible-comment".into(),
                    author: this.identity.as_ref().unwrap().user.clone(),
                    body: "Progress body readable without pointer input".into(),
                    source: "user".into(),
                    kind: Some("Progress".into()),
                    created_at: "2026-10-27T10:00:00Z".into(),
                    edited_at: None,
                    deleted_at: None,
                    replies: vec![],
                };
                let mut deleted = comment.clone();
                deleted.id = "deleted-comment".into();
                deleted.body = "Deleted private text must not be announced".into();
                deleted.deleted_at = Some("2026-10-27T10:01:00Z".into());
                this.comments = vec![comment, deleted];
                cx.notify();
            });
            window.render_frame(cx);
            assert_eq!(
                window.find("velvet-workspace").role(),
                Some(gpui_kit::Role::Main)
            );
            assert_eq!(
                window.find("velvet-workspace").label(),
                Some("Velvet workspace")
            );
            let author = &view.read(cx).identity.as_ref().unwrap().user.name;
            assert_eq!(
                window.find(("comment-author", 0usize)).label(),
                Some(author.as_str())
            );
            assert_eq!(
                window.find(("comment-body", 0usize)).role(),
                Some(gpui_kit::Role::Paragraph)
            );
            assert_eq!(
                window.find(("comment-body", 0usize)).label(),
                Some("Progress body readable without pointer input")
            );
            assert_eq!(
                window.find(("comment-body", 1usize)).label(),
                Some("Comment deleted.")
            );
            window.click("new", cx);
            assert_eq!(
                window.find("velvet-modal").role(),
                Some(gpui_kit::Role::Dialog)
            );
            assert_eq!(window.find("velvet-modal").label(), Some("Issue editor"));
            assert_eq!(
                window.find("overlay-heading").role(),
                Some(gpui_kit::Role::Heading)
            );
            assert_eq!(window.find("overlay-heading").label(), Some("New issue"));
        })
        .unwrap();
}

#[gpui_kit::test]
fn demo_renders_issue_buttons_and_selection(cx: &mut TestAppContext) {
    let (window, view) = demo(cx, 1440.);
    window
        .update(cx, |_, window, cx| {
            window.render_frame(cx);
            let issue = window.find(("issue", 0usize));
            assert!(issue.visible());
            assert!(issue.label().unwrap().contains("VEL-142"));
            assert!(window.find("new").visible());
            window.click(("issue", 1usize), cx);
            assert_eq!(view.read(cx).selected.as_ref().unwrap().key, "VEL-143");
            assert!(
                view.read(cx).client.is_none(),
                "demo must not create a network client"
            );
            assert!(view.read(cx).comments.is_empty());
        })
        .unwrap();
}

#[gpui_kit::test]
fn create_and_edit_drafts_stay_separate_across_workspaces(cx: &mut TestAppContext) {
    let (window, view) = demo(cx, 1280.);
    window
        .update(cx, |_, window, cx| {
            window.render_frame(cx);
            window.click("edit", cx);
            view.update(cx, |this, cx| {
                assert!(this.editing);
                this.title.update(cx, |input, cx| {
                    input.set_value("Private edit draft", window, cx)
                });
            });
            window.click("cancel-edit", cx);
            window.click("new", cx);
            view.update(cx, |this, cx| {
                assert!(this.edit_key.is_none());
                assert!(
                    this.title.read(cx).value().is_empty(),
                    "new issue must not reuse an edit draft"
                );
                this.title.update(cx, |input, cx| {
                    input.set_value("Workspace one draft", window, cx)
                });
            });
            window.click("cancel-edit", cx);
            view.update(cx, |this, cx| {
                let mut second = this.identity.as_ref().unwrap().memberships[0].clone();
                second.workspace_slug = "other".into();
                second.workspace_id = "other".into();
                this.identity.as_mut().unwrap().memberships.push(second);
                this.switch_workspace(1, window, cx);
                this.open_form(false, window, cx);
                assert!(
                    this.title.read(cx).value().is_empty(),
                    "workspace drafts must not cross organisations"
                );
                this.close_overlay(window, cx);
                this.switch_workspace(0, window, cx);
                this.open_form(false, window, cx);
                assert_eq!(this.title.read(cx).value().as_ref(), "Workspace one draft");
            });
            window.render_frame(cx);
            assert!(window.find("save-issue").visible());
        })
        .unwrap();
}

#[gpui_kit::test]
fn sign_out_modal_focus_stays_inside_and_escape_restores_focus(cx: &mut TestAppContext) {
    let (window, view) = demo(cx, 1280.);
    window
        .update(cx, |_, window, cx| {
            window.render_frame(cx);
            let previous = view.read(cx).focus.clone();
            window.focus(&previous, cx);
            view.update(cx, |this, cx| {
                this.composer.update(cx, |input, cx| {
                    input.set_value("Unsent private update", window, cx)
                });
                this.confirm_sign_out(window, cx);
            });
            window.render_frame(cx);
            assert!(view.read(cx).cancel_focus.is_focused(window));
            assert!(gpui_kit::base::active_focus_trap(window, cx).is_some());
            for key in ["tab", "shift-tab"] {
                for _ in 0..6 {
                    window.press(key, cx);
                    assert!(view.read(cx).modal_focus.contains_focused(window, cx));
                }
            }
            window.press("cmd-enter", cx);
            assert!(
                view.read(cx).error.is_none(),
                "modal must suppress background posting, including demo errors"
            );
            assert!(!view.read(cx).saving);
            window.press("escape", cx);
            assert!(!view.read(cx).confirm_logout);
            assert!(previous.is_focused(window));
            assert_eq!(
                view.read(cx).composer.read(cx).value().as_ref(),
                "Unsent private update"
            );
        })
        .unwrap();
}

#[gpui_kit::test]
fn demo_rejects_writes_and_narrow_layout_keeps_actions_visible(cx: &mut TestAppContext) {
    let (window, view) = demo(cx, 1000.);
    window
        .update(cx, |_, window, cx| {
            window.render_frame(cx);
            assert!(window.find("edit").visible());
            assert!(window.find("issue-status").visible());
            let original_status = view.read(cx).selected.as_ref().unwrap().status.clone();
            view.update(cx, |this, cx| {
                this.change_status("done".into(), cx);
                this.composer.update(cx, |input, cx| {
                    input.set_value("Should stay local", window, cx)
                });
                this.post(window, cx);
                assert_eq!(this.selected.as_ref().unwrap().status, original_status);
                assert!(this.comments.is_empty());
                assert!(this.client.is_none());
                assert!(!this.saving);
            });
            window.render_frame(cx);
            assert!(
                view.read(cx)
                    .error
                    .as_deref()
                    .unwrap()
                    .contains("read-only")
            );
        })
        .unwrap();
}

#[gpui_kit::test]
fn native_search_input_filters_rows_and_theme_keeps_controls_contained(cx: &mut TestAppContext) {
    let (window, view) = demo(cx, 1280.);
    window
        .update(cx, |_, window, cx| {
            window.render_frame(cx);
            view.update(cx, |this, cx| {
                this.search.update(cx, |input, cx| input.focus(window, cx))
            });
            window.input("Add keyboard", cx);
            assert_eq!(
                view.read(cx).search.read(cx).value().as_ref(),
                "Add keyboard"
            );
        })
        .unwrap();
    window
        .update(cx, |_, window, cx| {
            window.render_frame(cx);
            assert!(window.try_find(("issue", 0usize)).is_none());
            assert!(
                window
                    .find(("issue", 4usize))
                    .label()
                    .unwrap()
                    .contains("keyboard")
            );
            for dark in [true, false] {
                crate::theme::apply(dark, cx);
                window.render_frame(cx);
                assert_eq!(view.read(cx).dark, dark);
                let bounds = window.find("edit").bounds();
                assert!(bounds.origin.x >= px(0.));
                assert!(bounds.origin.x + bounds.size.width <= window.viewport_size().width);
            }
        })
        .unwrap();
}

#[gpui_kit::test]
fn native_composer_keeps_each_issue_draft_private(cx: &mut TestAppContext) {
    let (window, view) = demo(cx, 1280.);
    window
        .update(cx, |_, window, cx| {
            window.render_frame(cx);
            view.update(cx, |this, cx| {
                this.composer
                    .update(cx, |input, cx| input.focus(window, cx))
            });
            window.input("Only for the first issue", cx);
        })
        .unwrap();
    window
        .update(cx, |_, window, cx| {
            window.click(("issue", 1usize), cx);
            assert!(view.read(cx).composer.read(cx).value().is_empty());
        })
        .unwrap();
    window
        .update(cx, |_, window, cx| {
            window.click(("issue", 0usize), cx);
            assert_eq!(
                view.read(cx).composer.read(cx).value().as_ref(),
                "Only for the first issue"
            );
        })
        .unwrap();
}

#[gpui_kit::test]
fn quitting_from_editor_keeps_draft_when_cancelled_and_blocks_during_save(cx: &mut TestAppContext) {
    let (window, view) = demo(cx, 1280.);
    window
        .update(cx, |_, window, cx| {
            window.render_frame(cx);
            window.click("new", cx);
            window.input("Do not lose this draft", cx);
            window.press("cmd-q", cx);
            assert!(view.read(cx).quit_prompt);
            assert!(
                view.read(cx).editing,
                "quit confirmation must preserve its underlying editor"
            );
            assert!(window.find("cancel-quit").visible());
            assert!(view.read(cx).cancel_focus.is_focused(window));
            assert!(gpui_kit::base::active_focus_trap(window, cx).is_some());
            window.click("cancel-quit", cx);
            assert!(!view.read(cx).quit_prompt);
            assert!(view.read(cx).editing);
            assert_eq!(
                view.read(cx).title.read(cx).value().as_ref(),
                "Do not lose this draft"
            );
            assert!(window.find("save-issue").visible());
            window.press("cmd-q", cx);
            window.press("escape", cx);
            assert!(!view.read(cx).quit_prompt);
            assert!(view.read(cx).editing);
            view.update(cx, |this, cx| {
                this.saving = true;
                this.request_quit(window, cx);
                assert!(!this.quit_prompt);
                assert!(this.error.as_deref().unwrap().contains("Wait"));
                this.saving = false;
            });
        })
        .unwrap();
}
