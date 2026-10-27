use gpui_kit::component::{Theme, ThemeMode};
use gpui_kit::*;

#[derive(Clone, Copy)]
pub struct Palette {
    pub paper: Hsla,
    pub ink: Hsla,
    pub surface: Hsla,
    pub border: Hsla,
    pub muted: Hsla,
    /// grey-700: supporting text on the grey surface, where `muted` falls below 4.5:1.
    pub secondary: Hsla,
    pub danger: Hsla,
}

impl Palette {
    pub fn new(dark: bool) -> Self {
        let values = if dark {
            [
                0x0a0a0a, 0xffffff, 0x171717, 0x262626, 0xa3a3a3, 0xd4d4d4, 0xf87171,
            ]
        } else {
            [
                0xffffff, 0x000000, 0xf5f5f5, 0xe5e5e5, 0x737373, 0x404040, 0xb91c1c,
            ]
        };
        Self {
            paper: rgb(values[0]).into(),
            ink: rgb(values[1]).into(),
            surface: rgb(values[2]).into(),
            border: rgb(values[3]).into(),
            muted: rgb(values[4]).into(),
            secondary: rgb(values[5]).into(),
            danger: rgb(values[6]).into(),
        }
    }
}

pub fn apply(dark: bool, cx: &mut App) {
    Theme::change(
        if dark {
            ThemeMode::Dark
        } else {
            ThemeMode::Light
        },
        None,
        cx,
    );
    let p = Palette::new(dark);
    let theme = Theme::global_mut(cx);
    theme.font_family = ".AppleSystemUIFont".into();
    theme.font_size = px(16.);
    theme.radius = px(6.);
    let c = &mut theme.colors;
    c.background = p.paper;
    c.foreground = p.ink;
    c.border = p.border;
    c.input = p.border;
    c.primary = p.ink;
    c.primary_foreground = p.paper;
    c.primary_hover = p.muted;
    c.primary_active = p.ink;
    c.secondary = p.surface;
    c.secondary_foreground = p.ink;
    c.secondary_hover = p.border;
    c.muted = p.surface;
    c.muted_foreground = p.muted;
    c.accent = p.surface;
    c.accent_foreground = p.ink;
    c.ring = p.ink;
    c.sidebar = p.surface;
    c.sidebar_foreground = p.ink;
    c.sidebar_border = p.border;
}
