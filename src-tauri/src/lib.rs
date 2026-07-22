//! AI Usage Monitor — Tauri native layer.
//!
//! Responsibilities kept intentionally thin (spec: no business logic in the native/tray layer):
//!  - register the SQL plugin with the versioned migrations (SQLite lives in the app data dir),
//!  - expose keychain-backed secret commands (see `secret.rs`),
//!  - build the menu-bar / system-tray icon and forward menu clicks to the webview as events,
//!  - implement "hide window on close, keep running in the background" with a full-quit command,
//!  - register notification / autostart / dialog / fs / opener plugins.
//!
//! All forecasting, dedup, scheduling *decisions* etc. live in the TypeScript domain layer.

mod secret;
mod local_usage;
mod diagnostics;

use std::sync::Mutex;
use std::{fs, path::PathBuf};

use tauri::{
    LogicalSize, PhysicalPosition, Position, Size,
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    window::Color,
    Emitter, Manager, WindowEvent,
};

fn target_monitor(window: &tauri::WebviewWindow) -> Result<Option<tauri::Monitor>, String> {
    window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .map(Some)
        .map(Ok)
        .unwrap_or_else(|| window.primary_monitor().map_err(|e| e.to_string()))
}

fn position_for_target_size(
    window: &tauri::WebviewWindow,
    width: f64,
    height: f64,
    top_right: bool,
) -> Result<(), String> {
    if let Some(monitor) = target_monitor(window)? {
        let monitor_pos = monitor.position();
        let monitor_size = monitor.size();
        let scale = monitor.scale_factor();
        let target_width = (width * scale).round() as i32;
        let target_height = (height * scale).round() as i32;
        let top_margin = (12.0 * scale).round() as i32;
        // Do not query outer_size here: macOS can briefly return the previous mode's size after
        // set_size(), which was the reason compact windows missed the top-right and full windows
        // retained the old right-edge coordinate.
        let (x, y) = if top_right {
            (
                monitor_pos.x + monitor_size.width as i32 - target_width,
                monitor_pos.y + top_margin,
            )
        } else {
            (
                monitor_pos.x + (monitor_size.width as i32 - target_width) / 2,
                monitor_pos.y + (monitor_size.height as i32 - target_height) / 2,
            )
        };
        window
            .set_position(Position::Physical(PhysicalPosition::new(x, y)))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Layout cost of one strip element, in logical points, per size preset.
///
/// The strip window is not resizable, so a height that does not fit the content silently crops it
/// — `.strip-summary` centres its rows and hides the overflow, which trims equally from the top and
/// bottom and leaves no scrollbar to notice. A fixed height therefore only ever suited one row
/// count; four limits plus the reset-credit block already overflowed the old 150pt default.
///
/// Measured against the rendered layout at each preset. If the strip's paddings, gaps or font
/// sizes change in `global.css`, re-measure these.
struct StripMetrics {
    width: f64,
    min_width: f64,
    /// Top + bottom padding of `.strip-summary`.
    chrome: f64,
    gap: f64,
    row: f64,
    /// `.strip-reset-tickets`, which stacks the credit count and the credits' expiry dates.
    tickets: f64,
}

fn strip_metrics(size: Option<&str>) -> StripMetrics {
    match size {
        Some("small") => StripMetrics { width: 240.0, min_width: 210.0, chrome: 34.0, gap: 4.0, row: 18.0, tickets: 24.0 },
        Some("large") => StripMetrics { width: 330.0, min_width: 290.0, chrome: 41.0, gap: 6.0, row: 25.0, tickets: 31.0 },
        _ => StripMetrics { width: 280.0, min_width: 250.0, chrome: 38.0, gap: 5.0, row: 20.0, tickets: 28.0 },
    }
}

fn strip_width(size: Option<&str>) -> f64 {
    strip_metrics(size).width
}

fn strip_min_width(size: Option<&str>) -> f64 {
    strip_metrics(size).min_width
}

fn strip_height(size: Option<&str>, rows: Option<u32>, tickets: bool) -> f64 {
    let m = strip_metrics(size);
    // Clamped rather than trusted: the row count crosses the IPC boundary, and an absurd value
    // would produce a window taller than the screen.
    let rows = f64::from(rows.unwrap_or(3).clamp(1, 8));
    let stack = m.row * rows + m.gap * (rows - 1.0);
    // A few points of slack. The metrics were measured on one machine, and text that renders
    // even fractionally taller elsewhere would be cropped rather than merely tight — an exact
    // fit leaves no margin for that, and the failure is silent.
    const SLACK: f64 = 4.0;
    m.chrome + stack + if tickets { m.gap + m.tickets } else { 0.0 } + SLACK
}

#[tauri::command]
fn set_window_mode(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    widget_state: tauri::State<WidgetModeState>,
    pinned_state: tauri::State<PinnedState>,
    mode: String,
    pinned: bool,
    strip_size: Option<String>,
    strip_rows: Option<u32>,
    strip_tickets: Option<bool>,
) -> Result<(), String> {
    let widget = mode != "full";
    let strip = mode == "strip";
    if !matches!(mode.as_str(), "full" | "widget" | "strip") {
        return Err(format!("未知的視窗模式：{mode}"));
    }
    let (width, height, min_width, min_height) = if strip {
        (
            strip_width(strip_size.as_deref()),
            strip_height(strip_size.as_deref(), strip_rows, strip_tickets.unwrap_or(false)),
            strip_min_width(strip_size.as_deref()),
            strip_height(strip_size.as_deref(), Some(1), false),
        )
    } else if widget {
        (240.0, 300.0, 220.0, 250.0)
    } else {
        // Size against the current monitor in logical points. A fixed 1180×820 window is wider
        // than many Retina laptop displays even though their screenshot pixel dimensions look
        // large, so centering alone still leaves the right side off-screen.
        let (monitor_width, monitor_height) = window.current_monitor()
            .map_err(|e| e.to_string())?
            .map(|monitor| {
                let scale = monitor.scale_factor();
                (monitor.size().width as f64 / scale, monitor.size().height as f64 / scale)
            })
            .unwrap_or((1200.0, 800.0));
        (
            (monitor_width * 0.86).clamp(720.0, 1100.0),
            (monitor_height * 0.82).clamp(520.0, 760.0),
            720.0,
            520.0,
        )
    };
    window
        .set_min_size(Some(Size::Logical(LogicalSize::new(min_width, min_height))))
        .map_err(|e| e.to_string())?;
    window
        .set_size(Size::Logical(LogicalSize::new(width, height)))
        .map_err(|e| e.to_string())?;
    window.set_decorations(!widget).map_err(|e| e.to_string())?;
    window.set_resizable(!widget).map_err(|e| e.to_string())?;
    window.set_skip_taskbar(widget).map_err(|e| e.to_string())?;
    window.set_visible_on_all_workspaces(widget).map_err(|e| e.to_string())?;
    window.set_always_on_top(pinned).map_err(|e| e.to_string())?;
    window
        .set_background_color(Some(if widget {
            Color(0, 0, 0, 0)
        } else {
            Color(246, 247, 249, 255)
        }))
        .map_err(|e| e.to_string())?;
    if let Ok(mut value) = widget_state.0.lock() { *value = widget; }
    if let Ok(mut value) = pinned_state.0.lock() { *value = pinned; }
    let _ = window.emit("ui://widget-mode", widget);
    if widget {
        position_for_target_size(&window, width, height, true)?;
    } else {
        // Widget mode deliberately lives at the monitor's top-right. Once the full desktop
        // size is restored, discard that compact position so the large window is not stranded
        // partly off-screen on the right edge.
        position_for_target_size(&window, width, height, false)?;
    }
    let _ = diagnostics::append(&app, "info", "window_mode_changed", Some(&format!("{mode};pinned={pinned}")));
    Ok(())
}

/// Start the operating system's native window move operation. The HTML drag-region
/// hint is unreliable on transparent macOS WebViews, so the visible grip invokes
/// this command directly on primary-button press.
#[tauri::command]
fn start_window_dragging(window: tauri::WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

/// Minimize into the operating system's app icon without changing the current
/// full/widget/strip mode, so restoring returns to the same presentation.
#[tauri::command]
fn minimize_window(window: tauri::WebviewWindow) -> Result<(), String> {
    // Borderless compact windows are not always created with the native
    // miniaturizable style on macOS. Explicitly restore it before minimizing.
    window.set_minimizable(true).map_err(|error| error.to_string())?;
    window.minimize().map_err(|error| error.to_string())
}

use tauri_plugin_sql::{Migration, MigrationKind};

/// Whether closing the main window should hide it (background runtime) or quit the app.
/// Defaults to `true` (spec: keep running in background after window close).
struct HideOnClose(Mutex<bool>);
struct WidgetModeState(Mutex<bool>);
struct PinnedState(Mutex<bool>);

/// v0.2 changed the bundle identifier to remove the misleading `.app` suffix.
/// Copy the legacy app-data files once before the frontend opens SQLite.
#[cfg(target_os = "macos")]
fn migrate_legacy_app_data(app: &tauri::AppHandle) {
    let Ok(home) = app.path().home_dir() else { return };
    let legacy = home.join("Library/Application Support/com.aiusagemonitor.app");
    let Ok(current) = app.path().app_data_dir() else { return };
    if current.join("app.db").exists() || !legacy.join("app.db").exists() { return; }
    if fs::create_dir_all(&current).is_err() { return; }
    for name in ["app.db", "app.db-wal", "app.db-shm", "diagnostics.jsonl", "secrets.enc"] {
        let source: PathBuf = legacy.join(name);
        if source.exists() { let _ = fs::copy(source, current.join(name)); }
    }
}

#[cfg(not(target_os = "macos"))]
fn migrate_legacy_app_data(_app: &tauri::AppHandle) {}

#[tauri::command]
fn set_hide_on_close(state: tauri::State<HideOnClose>, value: bool) {
    if let Ok(mut guard) = state.0.lock() {
        *guard = value;
    }
}

/// Fully exit the app (used by the tray "Quit" item and the Settings "Quit" action).
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Show and focus the main window (from the tray or a "reopen" request).
#[tauri::command]
fn show_main_window(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// Update the tray tooltip with the current status line (e.g. "Claude Weekly: 41% left").
/// The frontend owns the copy; the native layer only renders it.
#[tauri::command]
fn update_tray_tooltip(app: tauri::AppHandle, tooltip: String) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("main-tray") {
        tray.set_tooltip(Some(&tooltip))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "init schema",
            sql: include_str!("../migrations/0001_init.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "deduplicate usage limits",
            sql: include_str!("../migrations/0002_deduplicate_usage_limits.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "prune seeded event preferences",
            sql: include_str!("../migrations/0003_prune_seeded_event_preferences.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:app.db", migrations())
                .build(),
        )
        .manage(HideOnClose(Mutex::new(true)))
        .manage(WidgetModeState(Mutex::new(false)))
        .manage(PinnedState(Mutex::new(false)))
        .invoke_handler(tauri::generate_handler![
            set_hide_on_close,
            quit_app,
            show_main_window,
            update_tray_tooltip,
            set_window_mode,
            start_window_dragging,
            minimize_window,
            diagnostics::diagnostic_log,
            diagnostics::diagnostic_export,
            local_usage::read_codex_local_usage,
            local_usage::read_claude_local_usage,
            local_usage::read_claude_usage_daily,
            secret::secret_set,
            secret::secret_get,
            secret::secret_delete,
            secret::secret_backend_available,
            secret::app_signature_is_adhoc,
        ])
        .setup(|app| {
            migrate_legacy_app_data(&app.handle());
            // --- Menu bar / system tray ---
            let open_i = MenuItem::with_id(app, "open", "Open Dashboard", true, None::<&str>)?;
            let check_i = MenuItem::with_id(app, "check_now", "Check Now", true, None::<&str>)?;
            let pause_i = MenuItem::with_id(app, "pause", "Pause Monitoring", true, None::<&str>)?;
            let resume_i =
                MenuItem::with_id(app, "resume", "Resume Monitoring", true, None::<&str>)?;
            let notif_i =
                MenuItem::with_id(app, "toggle_notifications", "Toggle Notifications", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit AI Usage Monitor", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&open_i, &check_i, &pause_i, &resume_i, &notif_i, &quit_i],
            )?;
            let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png"))?;

            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(tray_icon)
                .icon_as_template(true)
                .tooltip("AI Usage Monitor")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.emit("ui://request-widget-mode", false);
                            let _ = win.show();
                            let _ = win.unminimize();
                            let _ = win.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    // All monitoring/notification logic lives in the webview; forward as events.
                    other => {
                        let _ = app.emit("tray://action", other.to_string());
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { .. } = event {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
                            let visible_and_focused = win.is_visible().unwrap_or(false) && win.is_focused().unwrap_or(false);
                            if visible_and_focused {
                                let _ = win.hide();
                            } else {
                                let _ = app.emit("tray://action", "refresh_now".to_string());
                                let _ = win.emit("ui://request-widget-mode", true);
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let hide = window
                    .state::<HideOnClose>()
                    .0
                    .lock()
                    .map(|g| *g)
                    .unwrap_or(true);
                if hide {
                    // Keep running in the background; hide instead of destroying.
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            // Do not hide a widget merely because focus changed. macOS can emit a transient
            // Focused(false) between show() and set_focus(), which made the visible widget
            // disappear before its controls received the click. Tray click and Close remain
            // the explicit ways to hide it; pinning controls only the always-on-top behavior.
        })
        .run(tauri::generate_context!())
        .expect("error while running AI Usage Monitor");
}

#[cfg(test)]
mod strip_layout_tests {
    use super::strip_height;

    /// The numbers on the right are the rendered content heights measured in the browser at each
    /// preset. The window must be at least that tall, or `.strip-summary` crops rows silently.
    #[test]
    fn height_covers_the_rendered_content() {
        // 4 limits + the Codex reset-credit block — the layout that overflowed the old fixed 150.
        assert_eq!(strip_height(None, Some(4), true), 38.0 + 80.0 + 15.0 + 5.0 + 28.0 + 4.0);
        assert!(strip_height(None, Some(4), true) > 150.0, "the old fixed height cropped this");
        // Without credits the block costs nothing, including its gap.
        assert_eq!(strip_height(None, Some(4), false), 38.0 + 80.0 + 15.0 + 4.0);
        // A single row has no inter-row gap to pay for.
        assert_eq!(strip_height(None, Some(1), false), 38.0 + 20.0 + 4.0);
    }

    #[test]
    fn every_preset_grows_with_its_content() {
        for size in [Some("small"), None, Some("large")] {
            let one = strip_height(size, Some(1), false);
            assert!(strip_height(size, Some(4), false) > one);
            assert!(strip_height(size, Some(4), true) > strip_height(size, Some(4), false));
        }
        // Larger presets use larger type, so the same content needs more room.
        assert!(strip_height(Some("large"), Some(4), true) > strip_height(None, Some(4), true));
        assert!(strip_height(None, Some(4), true) > strip_height(Some("small"), Some(4), true));
    }

    #[test]
    fn an_absurd_row_count_cannot_produce_an_offscreen_window() {
        // The count crosses the IPC boundary; clamping keeps a bad value from resizing the window
        // past the screen. Zero rows still needs room for the chrome.
        assert_eq!(strip_height(None, Some(9_999), true), strip_height(None, Some(8), true));
        assert_eq!(strip_height(None, Some(0), false), strip_height(None, Some(1), false));
        assert_eq!(strip_height(None, None, false), strip_height(None, Some(3), false));
    }
}
