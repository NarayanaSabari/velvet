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
