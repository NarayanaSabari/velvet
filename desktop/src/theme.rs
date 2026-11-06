use gpui_kit::component::{Theme, ThemeMode};
use gpui_kit::*;
use std::borrow::Cow;

gpui_kit::assets::icon_assets!(
    AppIcons,
    [
        LayoutDashboard,
        ListTodo,
        Folder,
        IterationCw,
        ChartColumn,
        Rss,
        AtSign,
        GitPullRequest,
        NotebookPen,
        Search,
        ChevronsUpDown,
        SquarePen,
        ExternalLink,
        Plus,
        RefreshCw,
        Moon,
        Sun,
        LogOut,
        Download,
        CircleDashed,
        Circle,
        CircleDot,
        CircleEllipsis,
        CircleCheck,
        CircleX,
        SignalHigh,
        Milestone,
        ChevronUp,
        ChevronDown,
        UserRound,
    ]
);

/// The component bundle plus only the Lucide icons this app draws, so the
/// binary does not carry the whole catalog.
pub struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        match AppIcons.load(path)? {
            Some(bytes) => Ok(Some(bytes)),
            None => gpui_kit::assets::Assets.load(path),
        }
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        let mut paths = gpui_kit::assets::Assets.list(path)?;
        paths.extend(AppIcons.list(path)?);
        Ok(paths)
    }
}

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
    /// Completed state only, never the sole signal.
    pub done: Hsla,
    /// Liquid Glass chrome: translucent fills for vibrancy regions (sidebar, rail).
    pub glass: Hsla,
    /// Translucent fill for floating capsules (toolbar, chips, pickers).
    pub glass_strong: Hsla,
    /// Near-opaque reading surface for the list and document.
    pub card: Hsla,
    /// 0.5px top highlight that sells the glass edge.
    pub edge: Hsla,
    /// Hairline separators on glass.
    pub hair: Hsla,
}

impl Palette {
    pub fn new(dark: bool) -> Self {
        let values = if dark {
            [
                0x0a0a0a, 0xffffff, 0x171717, 0x262626, 0xa3a3a3, 0xd4d4d4, 0xf87171, 0x4ade80,
            ]
        } else {
            [
                0xffffff, 0x000000, 0xf5f5f5, 0xe5e5e5, 0x737373, 0x404040, 0xb91c1c, 0x15803d,
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
            done: rgb(values[7]).into(),
            glass: if dark {
                hsla(0., 0., 0.11, 0.55)
            } else {
                hsla(0., 0., 1., 0.55)
            },
            glass_strong: if dark {
                hsla(0., 0., 0.13, 0.72)
            } else {
                hsla(0., 0., 1., 0.72)
            },
            card: if dark {
                hsla(0., 0., 0.085, 0.86)
            } else {
                hsla(0., 0., 1., 0.86)
            },
            edge: if dark {
                hsla(0., 0., 1., 0.14)
            } else {
                hsla(0., 0., 1., 0.65)
            },
            hair: if dark {
                hsla(0., 0., 1., 0.09)
            } else {
                hsla(0., 0., 0., 0.08)
            },
        }
    }
    /// The user's macOS "Reduce transparency" setting. Glass falls back to
    /// opaque surfaces so text never sits on a moving backdrop.
    pub fn reduce_transparency() -> bool {
        std::process::Command::new("defaults")
            .args(["read", "com.apple.universalaccess", "reduceTransparency"])
            .output()
            .ok()
            .is_some_and(|o| String::from_utf8_lossy(&o.stdout).trim() == "1")
    }
    pub fn opaque(mut self) -> Self {
        self.glass = self.surface;
        self.glass_strong = self.surface;
        self.card = self.paper;
        self.edge = self.border;
        self.hair = self.border;
        self
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
