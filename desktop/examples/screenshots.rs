//! Run on the process main thread: cargo run --features ui-tests --example screenshots.
//! Uses only read-only demo data. PNGs stay under the ignored target directory.
#![cfg(feature = "ui-tests")]
#![allow(dead_code)]
#[path = "../src/api.rs"]
mod api;
#[path = "../src/app.rs"]
mod app;
#[path = "../src/credentials.rs"]
mod credentials;
#[path = "../src/pages.rs"]
mod pages;
#[path = "../src/state.rs"]
mod state;
#[path = "../src/theme.rs"]
mod theme;
#[path = "../src/update.rs"]
mod update;

use gpui_kit::test::TestWindowExt;
use gpui_kit::{
    AppContext, Bounds, Focusable, HeadlessAppContext, WindowBounds, WindowOptions, point, px, size,
};
use std::{path::PathBuf, sync::Arc};

fn main() -> anyhow::Result<()> {
    let output = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/screenshots");
    std::fs::create_dir_all(&output)?;
    // Mac text and Metal platform initialization require the process main thread.
    let platform = gpui_kit::platform::current_platform(true);
    for (name, width, dark, overlay) in [
        ("desktop-light", 1440., false, ""),
        ("desktop-dark", 1440., true, ""),
        ("narrow-light", 1000., false, ""),
        ("commands-light", 1280., false, "commands"),
        ("quit-light", 1280., false, "quit"),
        ("sprints-light", 1280., false, "sprints"),
        ("sprints-dark", 1280., true, "sprints"),
    ] {
        let mut cx = HeadlessAppContext::with_platform(
            platform.text_system(),
            Arc::new(gpui_kit::assets::Assets),
            gpui_kit::platform::current_headless_renderer,
        );
        // Create each viewport at its final size. TestPlatform resize does not emit native resize events.
        let (window, view) = cx.update(|cx| {
            gpui_kit::init(cx);
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds {
                        origin: point(px(0.), px(0.)),
                        size: size(px(width), px(900.)),
                    })),
                    show: false,
                    focus: false,
                    ..Default::default()
                },
                cx,
                |window, cx| {
                    let view =
                        cx.new(|cx| app::Velvet::new(app::DEFAULT_SERVER.into(), true, window, cx));
                    window.focus(&view.focus_handle(cx), cx);
                    view
                },
            )
        })?;
        cx.update_window(window, |_, window, cx| {
            theme::apply(dark, cx);
            window.render_frame(cx);
            if overlay == "commands" {
                window.click("commands", cx);
            } else if overlay == "sprints" {
                window.click("nav-sprints", cx);
                window.render_frame(cx);
                window.click(("milestone", 1usize), cx);
            } else if overlay == "quit" {
                window.click("new", cx);
                window.input("Unsent draft retained until you confirm", cx);
                window.dispatch_action(Box::new(app::Quit), cx);
            }
        })?;
        cx.run_until_parked();
        cx.update_window(window, |_, window, cx| window.render_frame(cx))?;
        let image = cx.capture_screenshot(window)?;
        let file = output.join(format!("{name}.png"));
        image.save(&file)?;
        println!("{} ({}x{})", file.display(), image.width(), image.height());
        drop(view);
    }
    Ok(())
}
