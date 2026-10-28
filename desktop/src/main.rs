mod api;
mod app;
mod credentials;
mod state;
mod theme;
mod update;

use app::*;
use gpui_kit::*;

fn main() {
    let mut server = DEFAULT_SERVER.to_owned();
    let mut demo = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--demo" => demo = true,
            "--server" => match args.next() {
                Some(value) => server = value,
                None => {
                    eprintln!("--server requires an HTTPS URL (HTTP allowed only for loopback)");
                    std::process::exit(2);
                }
            },
            "--help" | "-h" => {
                println!(
                    "Velvet for macOS {}\n\nUsage: velvet-desktop [--server URL] [--demo]\n\n--demo opens read-only sample data without network or Keychain access.",
                    update::CURRENT
                );
                return;
            }
            _ => {
                eprintln!("Unknown option: {arg}. Use --help.");
                std::process::exit(2);
            }
        }
    }
    let server = match api::normalize_server(&server) {
        Ok(server) => server,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    };
    gpui_kit::application()
        .with_assets(gpui_kit::assets::Assets)
        .run(move |cx| {
            gpui_kit::init(cx);
            cx.bind_keys([
                KeyBinding::new("cmd-q", Quit, None),
                KeyBinding::new("cmd-k", Commands, Some("Velvet")),
                KeyBinding::new("cmd-n", NewIssue, Some("Velvet")),
                KeyBinding::new("cmd-r", Refresh, Some("Velvet")),
                KeyBinding::new("alt-down", NextIssue, Some("Velvet")),
                KeyBinding::new("alt-up", PreviousIssue, Some("Velvet")),
                KeyBinding::new("escape", Dismiss, Some("Velvet")),
                KeyBinding::new("cmd-enter", PostUpdate, Some("Velvet")),
            ]);
            cx.set_menus(vec![
                Menu::new("Velvet").items([
                    MenuItem::action("Check for Updates…", CheckForUpdates),
                    MenuItem::action("Quit Velvet", Quit),
                ]),
                Menu::new("File").items([
                    MenuItem::action("New issue", NewIssue),
                    MenuItem::action("Refresh", Refresh),
                ]),
                Menu::new("View").items([
                    MenuItem::action("Commands", Commands),
                    MenuItem::action("Next issue", NextIssue),
                    MenuItem::action("Previous issue", PreviousIssue),
                ]),
            ]);
            let options = WindowOptions {
                window_bounds: Some(WindowBounds::centered(size(px(1440.), px(900.)), cx)),
                window_min_size: Some(size(px(1000.), px(680.))),
                titlebar: Some(TitlebarOptions {
                    title: Some("Velvet".into()),
                    ..Default::default()
                }),
                ..Default::default()
            };
            let (handle, view) = gpui_kit::open_window(options, cx, move |window, cx| {
                let view = cx.new(|cx| Velvet::new(server, demo, window, cx));
                let weak = view.downgrade();
                window.on_window_should_close(cx, move |window, cx| {
                    weak.update(cx, |view, cx| {
                        if !view.is_quitting() {
                            view.request_quit(window, cx);
                        }
                        view.is_quitting()
                    })
                    .unwrap_or(true)
                });
                window.focus(&view.focus_handle(cx), cx);
                view
            })
            .expect("Could not open Velvet");
            let weak = view.downgrade();
            cx.on_action(move |_: &Quit, cx| {
                let _ = handle.update(cx, |_, window, cx| {
                    let _ = weak.update(cx, |view, cx| view.request_quit(window, cx));
                });
            });
            cx.activate(true);
        });
}
