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

use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};
use tauri_plugin_sql::{Migration, MigrationKind};

/// Whether closing the main window should hide it (background runtime) or quit the app.
/// Defaults to `true` (spec: keep running in background after window close).
struct HideOnClose(Mutex<bool>);

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
    vec![Migration {
        version: 1,
        description: "init schema",
        sql: include_str!("../migrations/0001_init.sql"),
        kind: MigrationKind::Up,
    }]
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
        .invoke_handler(tauri::generate_handler![
            set_hide_on_close,
            quit_app,
            show_main_window,
            update_tray_tooltip,
            secret::secret_set,
            secret::secret_get,
            secret::secret_delete,
            secret::secret_backend_available,
        ])
        .setup(|app| {
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

            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .icon_as_template(true)
                .tooltip("AI Usage Monitor")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(win) = app.get_webview_window("main") {
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
                            let _ = win.show();
                            let _ = win.set_focus();
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
        })
        .run(tauri::generate_context!())
        .expect("error while running AI Usage Monitor");
}
