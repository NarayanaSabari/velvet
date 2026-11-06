//! Real Liquid Glass via AppKit's `NSGlassEffectView` (macOS 26+).
//!
//! gpui paints everything into one Metal layer, so it cannot host the system
//! material itself. Instead each glass region in the UI renders a transparent
//! [`glass_region`] placeholder that reports its bounds every frame, and this
//! module keeps one native `NSGlassEffectView` per region positioned under the
//! Metal view. The system samples the backdrop live, refracts the edges and
//! honours Reduce Transparency on its own.
//!
//! On macOS before 26 the class is missing and [`available`] is false, so the
//! app falls back to the painted `Palette::glass` tints.

use gpui_kit::*;
use std::cell::RefCell;
use std::collections::HashMap;

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use objc2::{MainThreadMarker, MainThreadOnly, Message, rc::Retained, runtime::AnyClass};
    use objc2_app_kit::{
        NSAutoresizingMaskOptions, NSGlassEffectView, NSGlassEffectViewStyle, NSView,
        NSWindowOrderingMode,
    };
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    pub fn available() -> bool {
        AnyClass::get(c"NSGlassEffectView").is_some()
    }

    pub struct Region {
        view: Retained<NSGlassEffectView>,
        last: Option<Bounds<Pixels>>,
    }

    pub struct Host {
        regions: HashMap<&'static str, Region>,
    }

    impl Host {
        pub fn new() -> Self {
            Self {
                regions: HashMap::new(),
            }
        }

        fn ns_view(window: &Window) -> Option<Retained<NSView>> {
            let handle = HasWindowHandle::window_handle(window).ok()?;
            let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
                return None;
            };
            // gpui's Metal view. Its superview is the window content view.
            let view = unsafe { (handle.ns_view.as_ptr() as *const NSView).as_ref() }?;
            Some(view.retain())
        }

        /// Place `name` at `bounds` (gpui window coordinates, top-left origin).
        pub fn place(
            &mut self,
            name: &'static str,
            bounds: Bounds<Pixels>,
            radius: Pixels,
            clear: bool,
            window: &Window,
        ) {
            let Some(metal) = Self::ns_view(window) else {
                return;
            };
            let Some(content) = (unsafe { metal.superview() }) else {
                return;
            };
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            let region = self.regions.entry(name).or_insert_with(|| {
                let frame = NSRect::new(NSPoint::new(0., 0.), NSSize::new(0., 0.));
                let view = NSGlassEffectView::initWithFrame(NSGlassEffectView::alloc(mtm), frame);
                view.setStyle(if clear {
                    NSGlassEffectViewStyle::Clear
                } else {
                    NSGlassEffectViewStyle::Regular
                });
                view.setAutoresizingMask(NSAutoresizingMaskOptions::empty());
                content.addSubview_positioned_relativeTo(
                    &view,
                    NSWindowOrderingMode::Below,
                    Some(&metal),
                );
                Region { view, last: None }
            });
            if region.last == Some(bounds) {
                return;
            }
            region.last = Some(bounds);
            // AppKit content views are bottom-left and in points; gpui gives
            // top-left pixels already divided by the scale factor.
            let height = content.bounds().size.height;
            let x = f64::from(f32::from(bounds.origin.x));
            let y = height
                - f64::from(f32::from(bounds.origin.y))
                - f64::from(f32::from(bounds.size.height));
            let frame = NSRect::new(
                NSPoint::new(x, y),
                NSSize::new(
                    f64::from(f32::from(bounds.size.width)),
                    f64::from(f32::from(bounds.size.height)),
                ),
            );
            region.view.setFrame(frame);
            region.view.setCornerRadius(f64::from(f32::from(radius)));
            if std::env::var_os("VELVET_GLASS_LOG").is_some() {
                let win_opaque = metal.window().map(|w| w.isOpaque());
                let layer_opaque = metal.layer().map(|l| l.isOpaque());
                let subviews = content.subviews().len();
                eprintln!(
                    "glass {name}: {x:.0},{y:.0} {}x{} win_opaque={win_opaque:?} layer_opaque={layer_opaque:?} content_subviews={subviews} hidden={}",
                    frame.size.width,
                    frame.size.height,
                    region.view.isHidden()
                );
            }
        }

        /// Hide regions that did not report bounds this frame.
        pub fn retain_only(&mut self, seen: &[&'static str]) {
            for (name, region) in &mut self.regions {
                let hidden = !seen.contains(name);
                region.view.setHidden(hidden);
                if hidden {
                    region.last = None;
                }
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod native {
    use super::*;
    pub fn available() -> bool {
        false
    }
    pub struct Host;
    impl Host {
        pub fn new() -> Self {
            Self
        }
        pub fn place(
            &mut self,
            _: &'static str,
            _: Bounds<Pixels>,
            _: Pixels,
            _: bool,
            _: &Window,
        ) {
        }
        pub fn retain_only(&mut self, _: &[&'static str]) {}
    }
}

pub use native::available;

/// Per-window glass state. Regions place themselves during paint and
/// [`Glass::begin_frame`] hides any region that did not paint last frame.
pub struct Glass {
    host: RefCell<native::Host>,
    seen: RefCell<Vec<&'static str>>,
}

impl Glass {
    pub fn new() -> Self {
        Self {
            host: RefCell::new(native::Host::new()),
            seen: RefCell::new(Vec::new()),
        }
    }

    /// Call at the top of `render`.
    pub fn begin_frame(&self) {
        let seen = std::mem::take(&mut *self.seen.borrow_mut());
        self.host.borrow_mut().retain_only(&seen);
    }
}

/// Transparent element that fills its parent and backs it with a native glass
/// view. Put it first inside a `relative()` container.
pub fn glass_region(
    glass: &std::rc::Rc<Glass>,
    name: &'static str,
    radius: Pixels,
    clear: bool,
) -> impl IntoElement {
    let glass = glass.clone();
    canvas(
        move |_, _, _| (),
        move |bounds, (), window, _| {
            glass
                .host
                .borrow_mut()
                .place(name, bounds, radius, clear, window);
            glass.seen.borrow_mut().push(name);
        },
    )
    .absolute()
    .inset_0()
}
