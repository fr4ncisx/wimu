mod backend;
mod presentation;
mod protocol;
#[cfg(windows)]
mod windows_native;

use backend::{request_backend_shutdown, AppRuntime, UsageState};
use serde::{Deserialize, Deserializer, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

const NORMAL_WINDOW_SIZE: (f64, f64) = (360.0, 220.0);
const NORMAL_WINDOW_MIN_SIZE: (f64, f64) = (320.0, 220.0);
const ULTRA_COMPACT_WINDOW_SIZE: (f64, f64) = (300.0, 156.0);
const ULTRA_COMPACT_WINDOW_MIN_SIZE: (f64, f64) = ULTRA_COMPACT_WINDOW_SIZE;
const MAX_WINDOW_DIMENSION: f64 = 4096.0;
const MAX_WINDOW_POSITION_COORDINATE: i32 = 65_536;
const RESIZE_SAVE_DEBOUNCE: Duration = Duration::from_millis(300);
const RESIZE_EVENT_SUPPRESSION: Duration = Duration::from_millis(700);

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSize {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowPosition {
    pub x: i32,
    pub y: i32,
}

impl WindowPosition {
    fn is_valid(self) -> bool {
        (-MAX_WINDOW_POSITION_COORDINATE..=MAX_WINDOW_POSITION_COORDINATE).contains(&self.x)
            && (-MAX_WINDOW_POSITION_COORDINATE..=MAX_WINDOW_POSITION_COORDINATE).contains(&self.y)
    }
}

fn window_position_has_visible_header(
    position: WindowPosition,
    window_size: (u32, u32),
    monitors: impl IntoIterator<Item = (i32, i32, u32, u32)>,
) -> bool {
    let left = i64::from(position.x);
    let top = i64::from(position.y);
    let header_right = left + i64::from(window_size.0.min(80));
    let header_bottom = top + i64::from(window_size.1.min(32));

    monitors.into_iter().any(|(x, y, width, height)| {
        let monitor_left = i64::from(x);
        let monitor_top = i64::from(y);
        let monitor_right = monitor_left + i64::from(width);
        let monitor_bottom = monitor_top + i64::from(height);
        let visible_width = (header_right.min(monitor_right) - left.max(monitor_left)).max(0);
        let visible_height = (header_bottom.min(monitor_bottom) - top.max(monitor_top)).max(0);
        visible_width >= i64::from(window_size.0.min(80))
            && visible_height >= i64::from(window_size.1.min(24))
    })
}

fn restore_window_position(window: &tauri::WebviewWindow, position: Option<WindowPosition>) {
    let _ = window.center();
    let Some(position) = position.filter(|position| position.is_valid()) else {
        return;
    };
    let (Ok(monitors), Ok(size)) = (window.available_monitors(), window.outer_size()) else {
        return;
    };
    let monitor_bounds = monitors.iter().map(|monitor| {
        let position = monitor.position();
        let size = monitor.size();
        (position.x, position.y, size.width, size.height)
    });
    if window_position_has_visible_header(position, (size.width, size.height), monitor_bounds) {
        let _ = window.set_position(tauri::PhysicalPosition::new(position.x, position.y));
    }
}

impl WindowSize {
    fn is_valid_for(self, ultra_compact: bool) -> bool {
        let (min_width, _) = window_minimum(ultra_compact);
        let fixed_height = if ultra_compact {
            ULTRA_COMPACT_WINDOW_SIZE.1
        } else {
            NORMAL_WINDOW_SIZE.1
        };
        let height_is_valid = (self.height - fixed_height).abs() <= 0.5;
        self.width.is_finite()
            && self.height.is_finite()
            && self.width >= min_width
            && height_is_valid
            && self.width <= MAX_WINDOW_DIMENSION
            && self.height <= MAX_WINDOW_DIMENSION
    }

    fn from_physical(width: u32, height: u32, scale_factor: f64) -> Option<Self> {
        if !scale_factor.is_finite() || scale_factor <= 0.0 {
            return None;
        }
        Some(Self {
            width: f64::from(width) / scale_factor,
            height: f64::from(height) / scale_factor,
        })
    }
}

fn default_normal_window_size() -> WindowSize {
    WindowSize {
        width: NORMAL_WINDOW_SIZE.0,
        height: NORMAL_WINDOW_SIZE.1,
    }
}

fn default_ultra_compact_window_size() -> WindowSize {
    WindowSize {
        width: ULTRA_COMPACT_WINDOW_SIZE.0,
        height: ULTRA_COMPACT_WINDOW_SIZE.1,
    }
}

fn window_minimum(ultra_compact: bool) -> (f64, f64) {
    if ultra_compact {
        ULTRA_COMPACT_WINDOW_MIN_SIZE
    } else {
        NORMAL_WINDOW_MIN_SIZE
    }
}

#[cfg(test)]
fn window_maximum(ultra_compact: bool) -> Option<WindowSize> {
    Some(WindowSize {
        width: MAX_WINDOW_DIMENSION,
        height: if ultra_compact {
            ULTRA_COMPACT_WINDOW_SIZE.1
        } else {
            NORMAL_WINDOW_SIZE.1
        },
    })
}

fn set_window_size_for_mode(
    window: &tauri::WebviewWindow,
    ultra_compact: bool,
    size: WindowSize,
) -> tauri::Result<()> {
    let minimum = (window_minimum(ultra_compact).0, size.height);
    #[cfg(windows)]
    windows_native::set_target(window, size.height, minimum.0);
    window.set_max_size(None::<tauri::LogicalSize<f64>>)?;
    window.set_min_size(None::<tauri::LogicalSize<f64>>)?;
    window.set_min_size(Some(tauri::LogicalSize::new(minimum.0, minimum.1)))?;
    window.set_max_size(Some(tauri::LogicalSize::new(
        MAX_WINDOW_DIMENSION,
        size.height,
    )))?;
    window.set_size(tauri::LogicalSize::new(size.width, size.height))
}

fn window_size_for(settings: &Settings, ultra_compact: bool) -> WindowSize {
    if ultra_compact {
        settings.ultra_compact_window_size
    } else {
        settings.normal_window_size
    }
}

fn set_window_size_for(settings: &mut Settings, ultra_compact: bool, size: WindowSize) {
    if ultra_compact {
        settings.ultra_compact_window_size = size;
    } else {
        settings.normal_window_size = size;
    }
}

fn normalized_window_size(size: WindowSize, ultra_compact: bool) -> WindowSize {
    let default = if ultra_compact {
        default_ultra_compact_window_size()
    } else {
        default_normal_window_size()
    };
    let minimum = window_minimum(ultra_compact);
    let width = if size.width.is_finite()
        && size.width >= minimum.0
        && size.width <= MAX_WINDOW_DIMENSION
    {
        size.width
    } else {
        default.width
    };
    WindowSize {
        width,
        height: default.height,
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CloseAction {
    Ask,
    Minimize,
    Quit,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    #[default]
    En,
    Es,
}

fn deserialize_language<'de, D>(deserializer: D) -> Result<Language, D::Error>
where
    D: Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(if value.as_str() == Some("es") {
        Language::Es
    } else {
        Language::En
    })
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    #[serde(rename = "threshold5h")]
    pub threshold_5h: f64,
    #[serde(rename = "thresholdWeekly")]
    pub threshold_weekly: f64,
    #[serde(default, deserialize_with = "deserialize_language")]
    pub language: Language,
    #[serde(default)]
    pub sound_enabled: bool,
    // Kept so settings files from older versions remain readable.
    #[serde(default = "default_ui_scale")]
    pub ui_scale: u16,
    #[serde(default = "default_always_on_top")]
    pub always_on_top: bool,
    #[serde(default = "default_close_action")]
    pub close_action: CloseAction,
    #[serde(default)]
    pub ultra_compact: bool,
    #[serde(default = "default_normal_window_size")]
    pub normal_window_size: WindowSize,
    #[serde(default = "default_ultra_compact_window_size")]
    pub ultra_compact_window_size: WindowSize,
    #[serde(default)]
    pub window_position: Option<WindowPosition>,
}

struct LanguageState(Mutex<Language>);

#[derive(Clone)]
struct SettingsFileLock(Arc<Mutex<()>>);

#[derive(Clone)]
struct WindowModeTracker(Arc<Mutex<WindowModeSnapshot>>);

struct PanelReadyState(AtomicBool);

#[derive(Clone)]
struct WindowGeometrySaveChannel(mpsc::Sender<WindowGeometrySaveRequest>);

#[derive(Clone, Copy)]
struct WindowModeSnapshot {
    ultra_compact: bool,
    revision: u64,
    suppress_until: Instant,
    settings_height: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct WindowSizeSaveRequest {
    ultra_compact: bool,
    revision: u64,
    size: WindowSize,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct WindowGeometrySaveRequest {
    size: Option<WindowSizeSaveRequest>,
    position: Option<WindowPosition>,
}

impl WindowGeometrySaveRequest {
    fn merge(&mut self, next: Self) {
        if next.size.is_some() {
            self.size = next.size;
        }
        if next.position.is_some() {
            self.position = next.position;
        }
    }
}

fn default_ui_scale() -> u16 {
    100
}

fn default_always_on_top() -> bool {
    true
}

fn default_close_action() -> CloseAction {
    CloseAction::Ask
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            threshold_5h: 20.0,
            threshold_weekly: 20.0,
            language: Language::En,
            sound_enabled: false,
            ui_scale: default_ui_scale(),
            always_on_top: default_always_on_top(),
            close_action: default_close_action(),
            ultra_compact: false,
            normal_window_size: default_normal_window_size(),
            ultra_compact_window_size: default_ultra_compact_window_size(),
            window_position: None,
        }
    }
}

impl Settings {
    fn is_valid(&self) -> bool {
        self.threshold_5h.is_finite()
            && self.threshold_weekly.is_finite()
            && (0.0..=100.0).contains(&self.threshold_5h)
            && (0.0..=100.0).contains(&self.threshold_weekly)
            && self.threshold_5h.fract() == 0.0
            && self.threshold_weekly.fract() == 0.0
            && (80..=150).contains(&self.ui_scale)
            && self.ui_scale % 10 == 0
            && self.window_position.map_or(true, WindowPosition::is_valid)
    }
}

#[tauri::command]
fn get_usage_state(runtime: State<'_, AppRuntime>) -> UsageState {
    runtime
        .state
        .lock()
        .map(|snapshot| snapshot.clone())
        .unwrap_or_default()
}

#[tauri::command]
fn load_settings(app: AppHandle) -> Result<Settings, String> {
    if let Some(file_lock) = app.try_state::<SettingsFileLock>() {
        if let Ok(_guard) = file_lock.0.lock() {
            return try_read_settings_file(&app);
        }
    }
    try_read_settings_file(&app)
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: serde_json::Value) -> Result<Settings, String> {
    let file_lock = app.try_state::<SettingsFileLock>();
    let _guard = match file_lock.as_ref() {
        Some(lock) => Some(
            lock.0
                .lock()
                .map_err(|_| "No se pudo guardar la configuración.".to_owned())?,
        ),
        None => None,
    };
    let current = try_read_settings_file(&app)?;
    let mut merged =
        serde_json::to_value(current).map_err(|_| "Could not save preferences".to_owned())?;
    let patch = settings.as_object().ok_or("Invalid preferences")?;
    for (key, value) in patch {
        if ![
            "threshold5h",
            "thresholdWeekly",
            "language",
            "soundEnabled",
            "uiScale",
            "alwaysOnTop",
            "closeAction",
            "ultraCompact",
            "windowPosition",
        ]
        .contains(&key.as_str())
        {
            return Err("Invalid preference field".into());
        }
        merged[key] = value.clone();
    }
    let settings: Settings =
        serde_json::from_value(merged).map_err(|_| "Invalid preferences".to_owned())?;
    if !settings.is_valid() {
        return Err("Invalid preferences".into());
    }
    write_settings_file(&app, &settings)?;
    let language_changed = app
        .try_state::<LanguageState>()
        .and_then(|state| {
            state.0.lock().ok().map(|mut current| {
                let changed = *current != settings.language;
                *current = settings.language;
                changed
            })
        })
        .unwrap_or(false);
    if language_changed {
        update_tray_language(&app, settings.language);
    }
    refresh_tray_indicators(&app);
    let _ = app.emit("preferences-updated", settings.clone());
    Ok(settings)
}

fn read_settings_file(app: &AppHandle) -> Settings {
    try_read_settings_file(app).unwrap_or_default()
}

fn decode_settings(value: serde_json::Value) -> Result<Settings, String> {
    let source = value.as_object().ok_or("Invalid preferences file")?;
    let mut normalized =
        serde_json::to_value(Settings::default()).map_err(|_| "Invalid defaults")?;
    for (key, value) in source {
        let valid = match key.as_str() {
            "threshold5h" | "thresholdWeekly" => value
                .as_f64()
                .is_some_and(|n| n.is_finite() && (0.0..=100.0).contains(&n)),
            "uiScale" => value
                .as_u64()
                .is_some_and(|n| (80..=150).contains(&n) && n % 10 == 0),
            "language" => matches!(value.as_str(), Some("en" | "es")),
            "soundEnabled" => value.is_boolean(),
            "closeAction" => matches!(value.as_str(), Some("ask" | "minimize" | "quit")),
            "alwaysOnTop" | "ultraCompact" => value.is_boolean(),
            "normalWindowSize" | "ultraCompactWindowSize" => {
                serde_json::from_value::<WindowSize>(value.clone()).is_ok()
            }
            "windowPosition" => {
                value.is_null()
                    || serde_json::from_value::<WindowPosition>(value.clone())
                        .map(WindowPosition::is_valid)
                        .unwrap_or(false)
            }
            _ => false,
        };
        if valid {
            normalized[key] = if key == "threshold5h" || key == "thresholdWeekly" {
                serde_json::json!(value.as_f64().unwrap_or(20.0).round())
            } else {
                value.clone()
            };
        }
    }
    let mut settings: Settings =
        serde_json::from_value(normalized).map_err(|_| "Invalid preferences file")?;
    settings.normal_window_size = normalized_window_size(settings.normal_window_size, false);
    settings.ultra_compact_window_size =
        normalized_window_size(settings.ultra_compact_window_size, true);
    Ok(settings)
}

fn try_read_settings_file(app: &AppHandle) -> Result<Settings, String> {
    let path = settings_path(app).map_err(|_| "Could not load preferences".to_owned())?;
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Settings::default())
        }
        Err(_) => return Err("Could not load preferences".into()),
    };
    decode_settings(
        serde_json::from_str(&contents).map_err(|_| "Could not load preferences".to_owned())?,
    )
}

fn write_settings_file(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app).map_err(|_| "Could not save preferences".to_owned())?;
    write_settings_path(&path, settings).map_err(|_| "Could not save preferences".to_owned())
}

fn write_settings_path(path: &std::path::Path, settings: &Settings) -> std::io::Result<()> {
    use std::io::Write;
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("Invalid settings path"))?;
    fs::create_dir_all(parent)?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = parent.join(format!("settings-{}-{nonce}.tmp", std::process::id()));
    let result = (|| {
        let serialized = serde_json::to_vec_pretty(settings)?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&serialized)?;
        file.sync_all()?;
        drop(file);
        #[cfg(windows)]
        windows_native::replace_file(&temporary, path)?;
        #[cfg(not(windows))]
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

fn run_window_mode_transition<T>(
    tracker: &WindowModeTracker,
    ultra_compact: bool,
    resize_window: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let previous_mode = {
        let mut mode = tracker
            .0
            .lock()
            .map_err(|_| "No se pudo cambiar el tamaño de la ventana.".to_owned())?;
        let previous_mode = (mode.ultra_compact, mode.settings_height);
        mode.ultra_compact = ultra_compact;
        mode.settings_height = None;
        mode.revision = mode.revision.wrapping_add(1);
        mode.suppress_until = Instant::now() + RESIZE_EVENT_SUPPRESSION;
        previous_mode
    };

    match resize_window() {
        Ok(result) => Ok(result),
        Err(error) => {
            if let Ok(mut mode) = tracker.0.lock() {
                mode.ultra_compact = previous_mode.0;
                mode.settings_height = previous_mode.1;
                mode.revision = mode.revision.wrapping_add(1);
                mode.suppress_until = Instant::now() + RESIZE_EVENT_SUPPRESSION;
            }
            Err(error)
        }
    }
}

#[cfg(test)]
fn window_mode_sizes(ultra_compact: bool) -> ((f64, f64), (f64, f64)) {
    if ultra_compact {
        (ULTRA_COMPACT_WINDOW_MIN_SIZE, ULTRA_COMPACT_WINDOW_SIZE)
    } else {
        (NORMAL_WINDOW_MIN_SIZE, NORMAL_WINDOW_SIZE)
    }
}

#[tauri::command]
fn set_ultra_compact(
    app: AppHandle,
    ultra_compact: bool,
    preferred_ultra_compact: Option<bool>,
) -> Result<WindowSize, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "No se pudo cambiar el tamaño de la ventana.".to_owned())?;
    let tracker = app
        .try_state::<WindowModeTracker>()
        .ok_or_else(|| "No se pudo cambiar el tamaño de la ventana.".to_owned())?;
    let scale_factor = window
        .scale_factor()
        .map_err(|_| "No se pudo cambiar el tamaño de la ventana.".to_owned())?;
    let current_size = window
        .inner_size()
        .ok()
        .and_then(|size| WindowSize::from_physical(size.width, size.height, scale_factor));
    let (size, previous_preference) = {
        let file_lock = app.try_state::<SettingsFileLock>();
        let _guard = match file_lock.as_ref() {
            Some(lock) => Some(
                lock.0
                    .lock()
                    .map_err(|_| "No se pudo cambiar el tamaño de la ventana.".to_owned())?,
            ),
            None => None,
        };
        let mode = tracker
            .0
            .lock()
            .map_err(|_| "No se pudo cambiar el tamaño de la ventana.".to_owned())?;
        let mut settings = try_read_settings_file(&app)?;
        let previous_preference = preferred_ultra_compact.map(|_| settings.ultra_compact);
        if let Some(preferred) = preferred_ultra_compact {
            settings.ultra_compact = preferred;
        }
        let valid_current_size = current_size
            .filter(|size| mode.settings_height.is_none() && size.is_valid_for(mode.ultra_compact));
        if let Some(size) = valid_current_size {
            set_window_size_for(&mut settings, mode.ultra_compact, size);
        }
        if previous_preference.is_some() || valid_current_size.is_some() {
            write_settings_file(&app, &settings)?;
        }
        (
            normalized_window_size(window_size_for(&settings, ultra_compact), ultra_compact),
            previous_preference,
        )
    };
    if let Err(error) = run_window_mode_transition(&tracker, ultra_compact, || {
        set_window_size_for_mode(&window, ultra_compact, size)
            .map_err(|_| "No se pudo cambiar el tamaño de la ventana.".to_owned())
    }) {
        if let Some(previous) = previous_preference {
            if let Some(file_lock) = app.try_state::<SettingsFileLock>() {
                if let Ok(_guard) = file_lock.0.lock() {
                    let mut settings = read_settings_file(&app);
                    settings.ultra_compact = previous;
                    let _ = write_settings_file(&app, &settings);
                }
            }
        }
        return Err(error);
    }

    if let Some(writer) = app
        .try_state::<WindowGeometrySaveChannel>()
        .map(|state| state.0.clone())
    {
        schedule_window_size_checkpoint(app.clone(), window, tracker.inner().clone(), writer);
    }
    Ok(size)
}

#[tauri::command]
fn fit_settings_window(app: AppHandle, content_height: f64) -> Result<WindowSize, String> {
    if !content_height.is_finite() || !(120.0..=1024.0).contains(&content_height) {
        return Err("Invalid settings height".into());
    }
    let window = app.get_webview_window("main").ok_or("Window unavailable")?;
    let scale = window.scale_factor().map_err(|_| "Window unavailable")?;
    let current = window.inner_size().map_err(|_| "Window unavailable")?;
    let size = WindowSize {
        width: (f64::from(current.width) / scale).max(NORMAL_WINDOW_MIN_SIZE.0),
        height: content_height.ceil(),
    };
    let tracker = app.state::<WindowModeTracker>();
    let previous = {
        let mut mode = tracker.0.lock().map_err(|_| "Window unavailable")?;
        let previous = *mode;
        mode.settings_height = Some(size.height);
        mode.revision = mode.revision.wrapping_add(1);
        mode.suppress_until = Instant::now() + RESIZE_EVENT_SUPPRESSION;
        previous
    };
    if set_window_size_for_mode(&window, false, size).is_err() {
        if let Ok(mut mode) = tracker.0.lock() {
            *mode = previous;
        }
        let original = WindowSize {
            width: f64::from(current.width) / scale,
            height: f64::from(current.height) / scale,
        };
        let _ = set_window_size_for_mode(&window, previous.ultra_compact, original);
        return Err("Could not resize settings".into());
    }
    Ok(size)
}

#[tauri::command]
fn get_native_window_mode(tracker: State<'_, WindowModeTracker>) -> Result<bool, String> {
    tracker
        .0
        .lock()
        .map(|mode| mode.ultra_compact)
        .map_err(|_| "No se pudo leer el tamaño de la ventana.".to_owned())
}

#[tauri::command]
fn show_main_panel(app: AppHandle) -> Result<(), String> {
    if let Some(ready) = app.try_state::<PanelReadyState>() {
        ready.0.store(true, Ordering::Release);
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "No se pudo mostrar la ventana.".to_owned())?;
    window
        .show()
        .map_err(|_| "No se pudo mostrar la ventana.".to_owned())
}

#[tauri::command]
fn minimize_panel(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "No se pudo minimizar la ventana.".to_owned())?;
    window
        .minimize()
        .map_err(|_| "No se pudo minimizar la ventana.".to_owned())?;
    Ok(())
}

#[tauri::command]
fn set_always_on_top(app: AppHandle, always_on_top: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "No se pudo cambiar el comportamiento de la ventana.".to_owned())?;
    window
        .set_always_on_top(always_on_top)
        .map_err(|_| "No se pudo cambiar el comportamiento de la ventana.".to_owned())
}

#[tauri::command]
fn quit_app(app: AppHandle, runtime: State<'_, AppRuntime>) {
    if let (Some(window), Some(tracker)) = (
        app.get_webview_window("main"),
        app.try_state::<WindowModeTracker>(),
    ) {
        persist_current_window_position(&app, &window, tracker.inner());
    }
    request_backend_shutdown(&runtime.commands);
    app.exit(0);
}

fn settings_path(app: &AppHandle) -> tauri::Result<PathBuf> {
    Ok(app.path().app_config_dir()?.join("settings.json"))
}

fn show_panel(app: &AppHandle) {
    if app
        .try_state::<PanelReadyState>()
        .is_some_and(|ready| !ready.0.load(Ordering::Acquire))
    {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("panel-restored", ());
    }
}

fn queue_window_size_save(
    writer: &mpsc::Sender<WindowGeometrySaveRequest>,
    tracker: &WindowModeTracker,
    size: WindowSize,
) {
    if let Ok(snapshot) = tracker.0.lock() {
        if snapshot.settings_height.is_some()
            || Instant::now() < snapshot.suppress_until
            || !size.is_valid_for(snapshot.ultra_compact)
        {
            return;
        }
        let _ = writer.send(WindowGeometrySaveRequest {
            size: Some(WindowSizeSaveRequest {
                ultra_compact: snapshot.ultra_compact,
                revision: snapshot.revision,
                size,
            }),
            position: None,
        });
    }
}

fn queue_window_position_save(
    writer: &mpsc::Sender<WindowGeometrySaveRequest>,
    position: &tauri::PhysicalPosition<i32>,
) {
    let position = WindowPosition {
        x: position.x,
        y: position.y,
    };
    if position.is_valid() {
        let _ = writer.send(WindowGeometrySaveRequest {
            size: None,
            position: Some(position),
        });
    }
}

fn queue_current_window_size_save(
    window: &tauri::WebviewWindow,
    writer: &mpsc::Sender<WindowGeometrySaveRequest>,
    tracker: &WindowModeTracker,
) {
    let scale_factor = window.scale_factor().unwrap_or(1.0);
    let Some(size) = window
        .inner_size()
        .ok()
        .and_then(|size| WindowSize::from_physical(size.width, size.height, scale_factor))
    else {
        return;
    };
    queue_window_size_save(writer, tracker, size);
}

fn queue_current_window_position_save(
    window: &tauri::WebviewWindow,
    writer: &mpsc::Sender<WindowGeometrySaveRequest>,
) {
    if let Ok(position) = window.outer_position() {
        queue_window_position_save(writer, &position);
    }
}

fn schedule_window_size_checkpoint(
    app: AppHandle,
    window: tauri::WebviewWindow,
    tracker: WindowModeTracker,
    writer: mpsc::Sender<WindowGeometrySaveRequest>,
) {
    let _ = thread::Builder::new()
        .name("window-size-checkpoint".into())
        .spawn(move || {
            thread::sleep(RESIZE_EVENT_SUPPRESSION);
            let _ = app.run_on_main_thread(move || {
                queue_current_window_size_save(&window, &writer, &tracker);
            });
        });
}

fn persist_window_geometry_request(
    app: &AppHandle,
    tracker: &WindowModeTracker,
    request: WindowGeometrySaveRequest,
) {
    let Some(file_lock) = app.try_state::<SettingsFileLock>() else {
        return;
    };
    let Ok(_guard) = file_lock.0.lock() else {
        return;
    };
    let Ok(mut settings) = try_read_settings_file(app) else {
        return;
    };
    let mut changed = false;
    if let Some(size) = request.size {
        if let Ok(snapshot) = tracker.0.lock() {
            if snapshot.settings_height.is_none()
                && snapshot.revision == size.revision
                && snapshot.ultra_compact == size.ultra_compact
                && size.size.is_valid_for(size.ultra_compact)
            {
                set_window_size_for(&mut settings, size.ultra_compact, size.size);
                changed = true;
            }
        }
    }
    if let Some(position) = request.position.filter(|position| position.is_valid()) {
        if settings.window_position != Some(position) {
            settings.window_position = Some(position);
            changed = true;
        }
    }
    if changed {
        let _ = write_settings_file(app, &settings);
    }
}

fn persist_current_window_position(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    tracker: &WindowModeTracker,
) {
    if let Ok(position) = window.outer_position() {
        let position = WindowPosition {
            x: position.x,
            y: position.y,
        };
        if position.is_valid() {
            persist_window_geometry_request(
                app,
                tracker,
                WindowGeometrySaveRequest {
                    size: None,
                    position: Some(position),
                },
            );
        }
    }
}

fn start_window_geometry_writer(
    app: AppHandle,
    receiver: mpsc::Receiver<WindowGeometrySaveRequest>,
    tracker: WindowModeTracker,
) {
    let _ = thread::Builder::new()
        .name("window-geometry-persistence".into())
        .spawn(move || {
            let mut pending: Option<WindowGeometrySaveRequest> = None;
            loop {
                if pending.is_some() {
                    match receiver.recv_timeout(RESIZE_SAVE_DEBOUNCE) {
                        Ok(request) => {
                            if let Some(pending) = pending.as_mut() {
                                pending.merge(request);
                            } else {
                                pending = Some(request);
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            if let Some(request) = pending.take() {
                                persist_window_geometry_request(&app, &tracker, request);
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            if let Some(request) = pending.take() {
                                persist_window_geometry_request(&app, &tracker, request);
                            }
                            break;
                        }
                    }
                } else {
                    match receiver.recv() {
                        Ok(request) => pending = Some(request),
                        Err(_) => break,
                    }
                }
            }
        });
}

const TRAY_LABEL_COLOR: [u8; 4] = [245, 246, 248, 255];
const TRAY_NEUTRAL_COLOR: [u8; 4] = [105, 107, 116, 255];

#[derive(Clone, Copy)]
struct TrayPercentage {
    value: f64,
    rounded: u32,
}

fn tray_percentage_from_decimal(value: &str) -> Option<TrayPercentage> {
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    if whole.is_empty()
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
        || (value.contains('.') && fraction.is_empty())
    {
        return None;
    }

    let whole = whole.parse::<u32>().ok()?;
    let percent = value.parse::<f64>().ok()?;
    if !percent.is_finite() || !(0.0..=100.0).contains(&percent) || whole > 100 {
        return None;
    }

    let round_up = fraction
        .as_bytes()
        .first()
        .is_some_and(|digit| *digit >= b'5');
    Some(TrayPercentage {
        value: percent,
        rounded: (whole + u32::from(round_up)).min(100),
    })
}

fn tray_percent_text(remaining: Option<TrayPercentage>, is_fresh: bool) -> String {
    match remaining.filter(|_| is_fresh) {
        Some(value) => format!("{}%", value.rounded),
        None => "—".to_owned(),
    }
}

fn tray_remaining_percent(
    window: Option<&protocol::UsageWindow>,
    is_fresh: bool,
) -> Option<TrayPercentage> {
    window
        .filter(|_| is_fresh)
        .and_then(|window| tray_percentage_from_decimal(&window.remaining_percent))
}

fn tray_glyph(character: char, compact_width: bool) -> [u8; 7] {
    if compact_width {
        return match character {
            '0' => [0b111, 0b101, 0b101, 0b101, 0b101, 0b101, 0b111],
            '1' => [0b010, 0b110, 0b010, 0b010, 0b010, 0b010, 0b111],
            '%' => [0b101, 0b001, 0b010, 0b010, 0b010, 0b100, 0b101],
            _ => [0; 7],
        };
    }

    match character {
        '0' => [0b1111, 0b1001, 0b1001, 0b1001, 0b1001, 0b1001, 0b1111],
        '1' => [0b0010, 0b0110, 0b0010, 0b0010, 0b0010, 0b0010, 0b0111],
        '2' => [0b1111, 0b0001, 0b0001, 0b1111, 0b1000, 0b1000, 0b1111],
        '3' => [0b1111, 0b0001, 0b0001, 0b0111, 0b0001, 0b0001, 0b1111],
        '4' => [0b1001, 0b1001, 0b1001, 0b1111, 0b0001, 0b0001, 0b0001],
        '5' => [0b1111, 0b1000, 0b1000, 0b1111, 0b0001, 0b0001, 0b1111],
        '6' => [0b1111, 0b1000, 0b1000, 0b1111, 0b1001, 0b1001, 0b1111],
        '7' => [0b1111, 0b0001, 0b0001, 0b0010, 0b0010, 0b0010, 0b0010],
        '8' => [0b1111, 0b1001, 0b1001, 0b1111, 0b1001, 0b1001, 0b1111],
        '9' => [0b1111, 0b1001, 0b1001, 0b1111, 0b0001, 0b0001, 0b1111],
        'H' => [0b1001, 0b1001, 0b1001, 0b1111, 0b1001, 0b1001, 0b1001],
        'D' => [0b1110, 0b1001, 0b1001, 0b1001, 0b1001, 0b1001, 0b1110],
        '%' => [0b1001, 0b0001, 0b0010, 0b0100, 0b1000, 0b1001, 0b0000],
        '—' => [0, 0, 0, 0b1111, 0, 0, 0],
        _ => [0; 7],
    }
}

fn set_icon_pixel(rgba: &mut [u8], x: u32, y: u32, color: [u8; 4]) {
    if x < 32 && y < 32 {
        let index = ((y * 32 + x) * 4) as usize;
        rgba[index..index + 4].copy_from_slice(&color);
    }
}

fn tray_text_width(text: &str, compact_width: bool) -> u32 {
    let glyph_width = if compact_width { 3 } else { 4 };
    text.chars().count() as u32 * glyph_width * 2
        + text
            .chars()
            .skip(1)
            .map(|character| tray_text_spacing(text, character))
            .sum::<u32>()
}

fn tray_text_spacing(text: &str, next_character: char) -> u32 {
    if next_character == '%' && text.chars().count() == 3 {
        6
    } else if next_character == '%' {
        4
    } else {
        2
    }
}

fn draw_tray_text(rgba: &mut [u8], text: &str, y: u32, color: [u8; 4]) {
    let characters: Vec<char> = text.chars().collect();
    let compact_width = text == "100%";
    let glyph_width = if compact_width { 3 } else { 4 };
    let character_width = glyph_width * 2;
    let text_width = tray_text_width(text, compact_width);
    let mut x = ((32 - text_width) / 2) & !1;
    for (character_index, character) in characters.iter().copied().enumerate() {
        let glyph = tray_glyph(character, compact_width);
        for (row, bits) in glyph.into_iter().enumerate() {
            for column in 0..glyph_width {
                if bits & (1 << (glyph_width - 1 - column)) != 0 {
                    for y_offset in 0..2 {
                        for x_offset in 0..2 {
                            set_icon_pixel(
                                rgba,
                                x + column * 2 + x_offset,
                                y + row as u32 * 2 + y_offset,
                                color,
                            );
                        }
                    }
                }
            }
        }
        x += character_width;
        if let Some(next_character) = characters.get(character_index + 1) {
            x += tray_text_spacing(text, *next_character);
        }
    }
}

fn tray_icon_pixels(
    is_weekly: bool,
    remaining: Option<TrayPercentage>,
    is_fresh: bool,
    threshold: f64,
) -> Vec<u8> {
    let mut rgba = vec![0u8; 32 * 32 * 4];
    let label = if is_weekly { "7D" } else { "5H" };
    let percentage = tray_percent_text(remaining, is_fresh);
    let label_color = TRAY_LABEL_COLOR;
    let value_color = match remaining.filter(|_| is_fresh) {
        Some(value) => {
            let color = presentation::palette(value.value, threshold).mid;
            [color[0], color[1], color[2], 255]
        }
        None => TRAY_NEUTRAL_COLOR,
    };
    draw_tray_text(&mut rgba, label, 0, label_color);
    draw_tray_text(&mut rgba, &percentage, 16, value_color);
    rgba
}

fn tray_icon(
    is_weekly: bool,
    remaining: Option<TrayPercentage>,
    is_fresh: bool,
    threshold: f64,
) -> tauri::image::Image<'static> {
    tauri::image::Image::new_owned(
        tray_icon_pixels(is_weekly, remaining, is_fresh, threshold),
        32,
        32,
    )
}

fn localized(language: Language, english: &'static str, spanish: &'static str) -> &'static str {
    match language {
        Language::En => english,
        Language::Es => spanish,
    }
}

fn tray_label(language: Language, is_weekly: bool) -> &'static str {
    if is_weekly {
        localized(language, "Weekly", "Semanal")
    } else {
        "5 h"
    }
}

fn tray_no_data(language: Language) -> &'static str {
    localized(language, "No data", "Sin datos")
}

fn tray_menu(app: &AppHandle, language: Language) -> tauri::Result<Menu<tauri::Wry>> {
    let open_item = MenuItem::with_id(
        app,
        "open",
        localized(language, "Show limits", "Mostrar límites"),
        true,
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(
        app,
        "quit",
        localized(language, "Close…", "Cerrar…"),
        true,
        None::<&str>,
    )?;
    Menu::with_items(app, &[&open_item, &quit_item])
}

fn update_tray_language(app: &AppHandle, language: Language) {
    let runner = app.clone();
    let menu_app = app.clone();
    let _ = runner.run_on_main_thread(move || {
        for id in ["five-hour", "weekly"] {
            let Some(icon) = menu_app.tray_by_id(id) else {
                continue;
            };
            if let Ok(menu) = tray_menu(&menu_app, language) {
                let _ = icon.set_menu(Some(menu));
            }
        }
    });
}

fn handle_tray_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match event.id.as_ref() {
        "open" => show_panel(app),
        "quit" => request_close_confirmation(app),
        _ => {}
    }
}

fn request_close_confirmation(app: &AppHandle) {
    if app
        .try_state::<PanelReadyState>()
        .is_some_and(|ready| !ready.0.load(Ordering::Acquire))
    {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        let _ = window.emit("close-requested", ());
    }
}

fn tooltip_text(value: String) -> Result<String, String> {
    if value.chars().any(char::is_control) {
        return Err("El texto de la bandeja no es válido.".into());
    }
    Ok(value.chars().take(127).collect())
}

#[tauri::command]
fn set_tray_tooltips(
    app: AppHandle,
    five_hour: String,
    weekly: String,
    revision: u64,
) -> Result<(), String> {
    if app
        .state::<AppRuntime>()
        .state
        .lock()
        .map_err(|_| "State unavailable")?
        .revision
        != revision
    {
        return Ok(());
    }
    let five_hour = tooltip_text(five_hour)?;
    let weekly = tooltip_text(weekly)?;
    let runner = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(icon) = runner.tray_by_id("five-hour") {
            let _ = icon.set_tooltip(Some(five_hour));
        }
        if let Some(icon) = runner.tray_by_id("weekly") {
            let _ = icon.set_tooltip(Some(weekly));
        }
    });
    Ok(())
}

pub(crate) fn update_tray_indicators(app: &AppHandle, state: &UsageState) {
    let snapshot = state.clone();
    let indicator_app = app.clone();
    let _ = app.run_on_main_thread(move || {
        if indicator_app
            .state::<AppRuntime>()
            .state
            .lock()
            .map(|state| state.revision > snapshot.revision)
            .unwrap_or(true)
        {
            return;
        }
        let settings = read_settings_file(&indicator_app);
        let is_fresh = matches!(snapshot.status.as_str(), "online" | "refreshing");
        for (id, is_weekly, window) in [
            ("five-hour", false, snapshot.five_hour.as_ref()),
            ("weekly", true, snapshot.weekly.as_ref()),
        ] {
            let remaining = tray_remaining_percent(window, is_fresh);
            if let Some(icon) = indicator_app.tray_by_id(id) {
                let _ = icon.set_icon(Some(tray_icon(
                    is_weekly,
                    remaining,
                    is_fresh && remaining.is_some(),
                    if is_weekly {
                        settings.threshold_weekly
                    } else {
                        settings.threshold_5h
                    },
                )));
            }
        }
    });
}

fn refresh_tray_indicators(app: &AppHandle) {
    if let Some(runtime) = app.try_state::<AppRuntime>() {
        let snapshot = runtime
            .state
            .lock()
            .map(|state| state.clone())
            .unwrap_or_default();
        update_tray_indicators(app, &snapshot);
    }
}

fn primary_tray_click(event: TrayIconEvent) -> Option<tauri::PhysicalPosition<f64>> {
    match event {
        TrayIconEvent::Click {
            position,
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } => Some(position),
        _ => None,
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_panel(app);
        }))
        .setup(|app| {
            let initial_settings = read_settings_file(app.handle());
            let initial_language = initial_settings.language;
            app.manage(SettingsFileLock(Arc::new(Mutex::new(()))));
            app.manage(LanguageState(Mutex::new(initial_language)));
            let window_mode_tracker = WindowModeTracker(Arc::new(Mutex::new(WindowModeSnapshot {
                ultra_compact: false,
                revision: 0,
                suppress_until: Instant::now() + RESIZE_EVENT_SUPPRESSION,
                settings_height: None,
            })));
            app.manage(window_mode_tracker.clone());
            app.manage(PanelReadyState(AtomicBool::new(false)));
            let (window_geometry_tx, window_geometry_rx) = mpsc::channel();
            start_window_geometry_writer(
                app.handle().clone(),
                window_geometry_rx,
                window_mode_tracker.clone(),
            );
            app.manage(WindowGeometrySaveChannel(window_geometry_tx.clone()));
            let initial_state = Arc::new(Mutex::new(UsageState::default()));
            let (command_tx, command_rx) = mpsc::channel();
            app.manage(AppRuntime {
                commands: command_tx.clone(),
                state: initial_state.clone(),
            });
            let five_hour_menu = tray_menu(app.handle(), initial_language)?;
            let five_hour_app = app.handle().clone();
            let _five_hour_tray = TrayIconBuilder::with_id("five-hour")
                .icon(tray_icon(false, None, false, initial_settings.threshold_5h))
                .tooltip(format!("5 h: {}", tray_no_data(initial_language)))
                .menu(&five_hour_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(handle_tray_menu_event)
                .on_tray_icon_event(move |_tray, event| {
                    if primary_tray_click(event).is_some() {
                        show_panel(&five_hour_app);
                    }
                })
                .build(app)?;

            let weekly_menu = tray_menu(app.handle(), initial_language)?;
            let weekly_app = app.handle().clone();
            let _weekly_tray = TrayIconBuilder::with_id("weekly")
                .icon(tray_icon(
                    true,
                    None,
                    false,
                    initial_settings.threshold_weekly,
                ))
                .tooltip(format!(
                    "{}: {}",
                    tray_label(initial_language, true),
                    tray_no_data(initial_language)
                ))
                .menu(&weekly_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(handle_tray_menu_event)
                .on_tray_icon_event(move |_tray, event| {
                    if primary_tray_click(event).is_some() {
                        show_panel(&weekly_app);
                    }
                })
                .build(app)?;

            backend::start_backend(app.handle().clone(), command_rx, initial_state)?;

            if let Some(window) = app.get_webview_window("main") {
                #[cfg(windows)]
                windows_native::install(&window).map_err(std::io::Error::other)?;
                if let Some(icon) = app.default_window_icon() {
                    let _ = window.set_icon(icon.clone());
                }
                let size = window_size_for(&initial_settings, initial_settings.ultra_compact);
                let initial_mode_applied =
                    set_window_size_for_mode(&window, initial_settings.ultra_compact, size).is_ok();
                if !initial_mode_applied {
                    let normal_size =
                        normalized_window_size(window_size_for(&initial_settings, false), false);
                    let _ = set_window_size_for_mode(&window, false, normal_size);
                }
                restore_window_position(&window, initial_settings.window_position);
                if let Ok(mut mode) = window_mode_tracker.0.lock() {
                    mode.ultra_compact = initial_mode_applied && initial_settings.ultra_compact;
                }
                let _ = window.set_always_on_top(initial_settings.always_on_top);
                let _ = window.set_skip_taskbar(true);
                let close_target = window.clone();
                let close_app = app.handle().clone();
                let close_tracker = window_mode_tracker.clone();
                let resize_target = window.clone();
                let geometry_writer = window_geometry_tx.clone();
                let resize_tracker = window_mode_tracker.clone();
                window.on_window_event(move |event| match event {
                    WindowEvent::CloseRequested { api, .. } => {
                        persist_current_window_position(&close_app, &close_target, &close_tracker);
                        api.prevent_close();
                        let _ = close_target.emit("close-requested", ());
                    }
                    WindowEvent::Resized(size) => {
                        let scale_factor = resize_target.scale_factor().unwrap_or(1.0);
                        if let Some(size) =
                            WindowSize::from_physical(size.width, size.height, scale_factor)
                        {
                            queue_window_size_save(&geometry_writer, &resize_tracker, size);
                        }
                    }
                    WindowEvent::Moved(position) => {
                        queue_window_position_save(&geometry_writer, position);
                    }
                    WindowEvent::Focused(false) => {
                        queue_current_window_size_save(
                            &resize_target,
                            &geometry_writer,
                            &resize_tracker,
                        );
                        queue_current_window_position_save(&resize_target, &geometry_writer);
                    }
                    _ => {}
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_usage_state,
            get_app_version,
            get_native_window_mode,
            show_main_panel,
            set_ultra_compact,
            fit_settings_window,
            load_settings,
            save_settings,
            minimize_panel,
            set_always_on_top,
            set_tray_tooltips,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("falló la aplicación de límites");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tray_percentage_for_test(value: f64) -> Option<TrayPercentage> {
        tray_percentage_from_decimal(&value.to_string())
    }

    #[test]
    fn app_version_is_exposed_to_the_main_window() {
        assert_eq!(get_app_version(), env!("CARGO_PKG_VERSION"));

        let permissions = include_str!("../permissions/usage.toml");
        assert!(
            permissions
                .lines()
                .any(|line| line.trim() == "\"get_app_version\","),
            "get_app_version must be allowed by the main window capability"
        );
    }

    #[test]
    fn threshold_defaults_and_bounds_are_explicit() {
        let defaults = Settings::default();
        assert_eq!(defaults.threshold_5h, 20.0);
        assert_eq!(defaults.threshold_weekly, 20.0);
        assert_eq!(defaults.ui_scale, 100);
        assert!(defaults.is_valid());
        assert!(!Settings {
            threshold_5h: 100.1,
            threshold_weekly: 20.0,
            language: Language::En,
            sound_enabled: false,
            ui_scale: 100,
            always_on_top: true,
            close_action: CloseAction::Ask,
            ultra_compact: false,
            normal_window_size: default_normal_window_size(),
            ultra_compact_window_size: default_ultra_compact_window_size(),
            window_position: None,
        }
        .is_valid());
        assert!(!Settings {
            threshold_5h: f64::NAN,
            threshold_weekly: 20.0,
            language: Language::En,
            sound_enabled: false,
            ui_scale: 100,
            always_on_top: true,
            close_action: CloseAction::Ask,
            ultra_compact: false,
            normal_window_size: default_normal_window_size(),
            ultra_compact_window_size: default_ultra_compact_window_size(),
            window_position: None,
        }
        .is_valid());
        assert!(!Settings {
            threshold_5h: 20.0,
            threshold_weekly: 20.0,
            language: Language::En,
            sound_enabled: false,
            ui_scale: 105,
            always_on_top: true,
            close_action: CloseAction::Ask,
            ultra_compact: false,
            normal_window_size: default_normal_window_size(),
            ultra_compact_window_size: default_ultra_compact_window_size(),
            window_position: None,
        }
        .is_valid());
    }

    #[test]
    fn settings_json_uses_the_frontend_contract() {
        let encoded = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(
            encoded,
            serde_json::json!({
                "threshold5h": 20.0,
                "thresholdWeekly": 20.0,
                "language": "en",
                "soundEnabled": false,
                "uiScale": 100,
                "alwaysOnTop": true,
                "closeAction": "ask",
                "ultraCompact": false,
                "normalWindowSize": { "width": 360.0, "height": 220.0 },
                "ultraCompactWindowSize": { "width": 300.0, "height": 156.0 },
                "windowPosition": null
            })
        );
        let decoded: Settings = serde_json::from_value(encoded).unwrap();
        assert_eq!(decoded.threshold_5h, 20.0);
        assert_eq!(decoded.ui_scale, 100);
        assert_eq!(decoded.language, Language::En);
        assert!(!decoded.sound_enabled);
        assert!(decoded.always_on_top);
        assert!(!decoded.ultra_compact);
        assert_eq!(decoded.normal_window_size, default_normal_window_size());
        assert_eq!(
            decoded.ultra_compact_window_size,
            default_ultra_compact_window_size()
        );
        assert_eq!(decoded.window_position, None);
    }

    #[test]
    fn existing_settings_without_scale_keep_their_thresholds() {
        let old_settings = serde_json::json!({
            "threshold5h": 15.5,
            "thresholdWeekly": 8.0
        });
        let decoded: Settings = serde_json::from_value(old_settings).unwrap();
        assert_eq!(decoded.threshold_5h, 15.5);
        assert_eq!(decoded.threshold_weekly, 8.0);
        assert_eq!(decoded.ui_scale, 100);
        assert!(decoded.always_on_top);
        assert_eq!(decoded.language, Language::En);
        assert!(!decoded.sound_enabled);
        assert!(!decoded.ultra_compact);
        assert_eq!(decoded.normal_window_size, default_normal_window_size());
        assert_eq!(
            decoded.ultra_compact_window_size,
            default_ultra_compact_window_size()
        );
        assert_eq!(decoded.window_position, None);
    }

    #[test]
    fn window_position_round_trips_for_monitors_left_of_primary() {
        let decoded = decode_settings(serde_json::json!({
            "windowPosition": { "x": -1920, "y": 120 }
        }))
        .unwrap();

        assert_eq!(
            decoded.window_position,
            Some(WindowPosition { x: -1920, y: 120 })
        );
    }

    #[test]
    fn invalid_window_position_is_ignored_without_losing_other_preferences() {
        let decoded = decode_settings(serde_json::json!({
            "threshold5h": 17,
            "windowPosition": { "x": 100_000, "y": 40 }
        }))
        .unwrap();

        assert_eq!(decoded.threshold_5h, 17.0);
        assert_eq!(decoded.window_position, None);
    }

    #[test]
    fn geometry_save_requests_keep_the_latest_size_and_position() {
        let size = |width| WindowSizeSaveRequest {
            ultra_compact: false,
            revision: 1,
            size: WindowSize {
                width,
                height: NORMAL_WINDOW_SIZE.1,
            },
        };
        let mut request = WindowGeometrySaveRequest {
            size: Some(size(360.0)),
            position: Some(WindowPosition { x: 12, y: 34 }),
        };

        request.merge(WindowGeometrySaveRequest {
            size: None,
            position: Some(WindowPosition { x: -1920, y: 0 }),
        });
        request.merge(WindowGeometrySaveRequest {
            size: Some(size(420.0)),
            position: None,
        });

        assert_eq!(request.size, Some(size(420.0)));
        assert_eq!(request.position, Some(WindowPosition { x: -1920, y: 0 }));
    }

    #[test]
    fn saved_position_requires_a_visible_header_area() {
        let monitor = [(-1920, 0, 1920, 1080)];

        assert!(window_position_has_visible_header(
            WindowPosition { x: -1900, y: 20 },
            (300, 156),
            monitor
        ));
        assert!(!window_position_has_visible_header(
            WindowPosition { x: -3000, y: 20 },
            (300, 156),
            monitor
        ));
        assert!(!window_position_has_visible_header(
            WindowPosition { x: -1980, y: 20 },
            (300, 156),
            monitor
        ));
    }

    #[test]
    fn compact_and_normal_window_sizes_are_distinct_and_bounded() {
        assert_eq!(window_mode_sizes(true), ((300.0, 156.0), (300.0, 156.0)));
        assert_eq!(
            window_mode_sizes(false),
            ((320.0, 220.0), NORMAL_WINDOW_SIZE)
        );
        assert_eq!(
            window_maximum(true),
            Some(WindowSize {
                width: MAX_WINDOW_DIMENSION,
                height: ULTRA_COMPACT_WINDOW_SIZE.1,
            })
        );
        assert_eq!(
            window_maximum(false),
            Some(WindowSize {
                width: MAX_WINDOW_DIMENSION,
                height: NORMAL_WINDOW_SIZE.1,
            })
        );
    }

    #[test]
    fn compact_size_keeps_its_width_but_forces_the_fixed_height() {
        let resized = WindowSize {
            width: 420.0,
            height: 410.0,
        };

        assert!(!resized.is_valid_for(true));
        assert_eq!(
            normalized_window_size(resized, true),
            WindowSize {
                width: 420.0,
                height: ULTRA_COMPACT_WINDOW_SIZE.1,
            }
        );
    }

    #[test]
    fn normal_size_keeps_its_width_and_discards_saved_vertical_slack() {
        let resized = WindowSize {
            width: 420.0,
            height: 410.0,
        };

        assert!(!resized.is_valid_for(false));
        assert_eq!(
            normalized_window_size(resized, false),
            WindowSize {
                width: 420.0,
                height: NORMAL_WINDOW_SIZE.1,
            }
        );
    }

    #[test]
    fn native_window_resize_runs_without_holding_the_mode_lock() {
        let tracker = WindowModeTracker(Arc::new(Mutex::new(WindowModeSnapshot {
            ultra_compact: true,
            revision: 4,
            suppress_until: Instant::now(),
            settings_height: None,
        })));

        let result = run_window_mode_transition(&tracker, false, || {
            let mode = tracker.0.try_lock().expect("mode lock must be released");
            assert!(!mode.ultra_compact);
            Ok(())
        });

        assert!(result.is_ok());
        assert!(!tracker.0.lock().unwrap().ultra_compact);
    }

    #[test]
    fn failed_native_resize_restores_the_previous_window_mode() {
        let tracker = WindowModeTracker(Arc::new(Mutex::new(WindowModeSnapshot {
            ultra_compact: true,
            revision: 4,
            suppress_until: Instant::now(),
            settings_height: None,
        })));

        let result = run_window_mode_transition(&tracker, false, || {
            Err::<(), _>("resize failed".to_owned())
        });

        assert_eq!(result, Err("resize failed".to_owned()));
        assert!(tracker.0.lock().unwrap().ultra_compact);
    }

    #[test]
    fn window_sizes_are_independent_and_restore_as_logical_dimensions() {
        let mut settings = Settings::default();
        let normal = WindowSize {
            width: 400.0,
            height: NORMAL_WINDOW_SIZE.1,
        };
        let compact = WindowSize {
            width: 320.0,
            height: ULTRA_COMPACT_WINDOW_SIZE.1,
        };
        set_window_size_for(&mut settings, false, normal);
        set_window_size_for(&mut settings, true, compact);

        assert_eq!(window_size_for(&settings, false), normal);
        assert_eq!(window_size_for(&settings, true), compact);
        assert!(normalized_window_size(normal, false).is_valid_for(false));
        assert!(normalized_window_size(compact, true).is_valid_for(true));
        for scale_factor in [1.0, 1.25, 1.5, 2.0] {
            assert_eq!(
                WindowSize::from_physical(
                    (normal.width * scale_factor) as u32,
                    (normal.height * scale_factor) as u32,
                    scale_factor,
                ),
                Some(normal)
            );
        }
        let restored: Settings =
            serde_json::from_value(serde_json::to_value(&settings).unwrap()).unwrap();
        assert_eq!(window_size_for(&restored, false), normal);
        assert_eq!(window_size_for(&restored, true), compact);
        assert_eq!(
            normalized_window_size(
                WindowSize {
                    width: 250.0,
                    height: 120.0,
                },
                true
            ),
            default_ultra_compact_window_size()
        );
    }

    #[test]
    fn tray_percent_text_rounds_clamps_and_omits_stale_values() {
        for remaining in 0..=100 {
            let value = remaining.to_string();
            assert_eq!(
                tray_percent_text(tray_percentage_from_decimal(&value), true),
                format!("{remaining}%")
            );
        }
        for (remaining, expected) in [
            ("0", "0%"),
            ("0.4", "0%"),
            ("0.5", "1%"),
            ("19.49", "19%"),
            ("19.5", "20%"),
            ("99.9", "100%"),
            ("100", "100%"),
            ("100.0", "100%"),
        ] {
            assert_eq!(
                tray_percent_text(tray_percentage_from_decimal(remaining), true),
                expected
            );
        }
        assert!(tray_percentage_from_decimal("101").is_none());
        assert!(tray_percentage_from_decimal("-1").is_none());
        assert!(tray_percentage_from_decimal("NaN").is_none());
        assert_eq!(tray_percent_text(None, true), "—");
        assert_eq!(
            tray_percent_text(tray_percentage_from_decimal("61"), false),
            "—"
        );
    }

    #[test]
    fn tray_rounding_preserves_half_percent_values_from_codex() {
        for (used_percent, expected) in [(85.5, "15%"), (71.5, "29%"), (43.5, "57%"), (42.5, "58%")]
        {
            let windows = protocol::parse_rate_limits(&serde_json::json!({
                "rateLimits": {
                    "primary": {
                        "usedPercent": used_percent,
                        "windowDurationMins": protocol::FIVE_HOUR_WINDOW_MINS,
                        "resetsAt": 1_800_000_000
                    }
                }
            }))
            .unwrap();
            assert!(tray_remaining_percent(windows.five_hour.as_ref(), false).is_none());
            let remaining = tray_remaining_percent(windows.five_hour.as_ref(), true);
            assert_eq!(tray_percent_text(remaining, true), expected);
        }
    }

    #[test]
    fn tray_rounding_uses_exact_decimal_digits_near_half_percent() {
        let payload = serde_json::from_str(
            r#"{"rateLimits":{"primary":{"usedPercent":85.5000000000000001,"windowDurationMins":300,"resetsAt":1800000000}}}"#,
        )
        .unwrap();
        let windows = protocol::parse_rate_limits(&payload).unwrap();
        let window = windows.five_hour.unwrap();
        assert_eq!(window.remaining_percent, "14.4999999999999999");
        let remaining = tray_remaining_percent(Some(&window), true);
        assert_eq!(tray_percent_text(remaining, true), "14%");
    }

    #[test]
    fn tray_icons_use_shared_threshold_colors_and_neutral_unavailable_state() {
        for (is_weekly, threshold) in [(false, 10.0), (true, 50.0)] {
            for remaining in (0_u32..=100).map(f64::from).chain([
                threshold - 0.01,
                threshold + 0.01,
                threshold + 4.99,
                threshold + 5.0,
                threshold + 5.01,
            ]) {
                let rgba = tray_icon_pixels(
                    is_weekly,
                    tray_percentage_for_test(remaining),
                    true,
                    threshold,
                );
                let expected = presentation::palette(remaining, threshold).mid;
                assert!(rgba
                    .chunks_exact(4)
                    .enumerate()
                    .any(|(index, pixel)| index / 32 >= 16 && pixel[..3] == expected));
            }
        }
        for (remaining, is_fresh) in [(None, true), (Some(61.0), false), (Some(f64::NAN), true)] {
            let remaining = remaining.and_then(tray_percentage_for_test);
            let rgba = tray_icon_pixels(false, remaining, is_fresh, 20.0);
            assert!(rgba
                .chunks_exact(4)
                .enumerate()
                .any(|(index, pixel)| index / 32 >= 16 && pixel == TRAY_NEUTRAL_COLOR));
            assert!(!rgba
                .chunks_exact(4)
                .enumerate()
                .any(|(index, pixel)| index / 32 >= 16
                    && pixel[..3] == presentation::palette(61.0, 20.0).mid));
        }
    }

    #[test]
    fn tray_icons_stack_period_and_larger_colored_value_without_separator() {
        let rgba = tray_icon_pixels(false, tray_percentage_for_test(8.0), true, 20.0);
        assert!((0..10).any(|y| {
            (0..32).any(|x| {
                let index = ((y * 32 + x) * 4) as usize;
                rgba[index..index + 4] == [245, 246, 248, 255]
            })
        }));
        for y in 14..16 {
            for x in 0..32 {
                let index = ((y * 32 + x) * 4) as usize;
                assert_eq!(&rgba[index..index + 4], &[0, 0, 0, 0]);
            }
        }
        assert!((0..32).any(|x| {
            let index = ((9 * 32 + x) * 4) as usize;
            rgba[index..index + 4] == TRAY_LABEL_COLOR
        }));
        for y in 30..32 {
            assert!((0..32).all(|x| {
                let index = ((y * 32 + x) * 4) as usize;
                rgba[index + 3] == 0
            }));
        }
        let value_color = presentation::palette(8.0, 20.0).mid;
        for y in [16, 29] {
            assert!((0..32).any(|x| {
                let index = ((y * 32 + x) * 4) as usize;
                rgba[index..index + 3] == value_color
            }));
        }
        assert!((0..32).any(|x| {
            let index = ((25 * 32 + x) * 4) as usize;
            rgba[index..index + 3] == value_color
        }));
    }

    #[test]
    fn tray_percentage_sign_has_a_clear_gap_after_the_number() {
        let rgba = tray_icon_pixels(false, tray_percentage_for_test(73.0), true, 20.0);
        for y in 16..30 {
            for x in 18..24 {
                let index = ((y * 32 + x) * 4) as usize;
                assert_eq!(&rgba[index..index + 4], &[0, 0, 0, 0]);
            }
        }
    }

    #[test]
    fn tray_percentages_are_centered_and_spaced_from_the_period_label() {
        for remaining in [Some(8.0), Some(27.0), Some(100.0), None] {
            let remaining = remaining.and_then(tray_percentage_for_test);
            let rgba = tray_icon_pixels(false, remaining, true, 20.0);
            for y in 14..16 {
                assert!((0..32).all(|x| {
                    let index = ((y * 32 + x) * 4) as usize;
                    rgba[index + 3] == 0
                }));
            }
            let occupied_x: Vec<u32> = rgba
                .chunks_exact(4)
                .enumerate()
                .filter(|(index, pixel)| index / 32 >= 16 && index / 32 < 30 && pixel[3] != 0)
                .map(|(index, _)| (index % 32) as u32)
                .collect();
            let min_x = *occupied_x.iter().min().unwrap();
            let max_x = *occupied_x.iter().max().unwrap();
            assert_eq!(min_x + max_x, 31);
        }
    }

    #[test]
    fn tray_icon_text_fits_and_centers_the_full_100_percent_value() {
        for is_weekly in [false, true] {
            let rgba = tray_icon_pixels(is_weekly, tray_percentage_for_test(100.0), true, 20.0);
            assert_eq!(rgba.len(), 32 * 32 * 4);
            let occupied_x: Vec<u32> = rgba
                .chunks_exact(4)
                .enumerate()
                .filter(|(index, pixel)| index / 32 >= 16 && pixel[3] != 0)
                .map(|(index, _)| (index % 32) as u32)
                .collect();
            let min_x = *occupied_x.iter().min().unwrap();
            let max_x = *occupied_x.iter().max().unwrap();
            assert_eq!(min_x, 0);
            assert_eq!(max_x, 31);
            assert_eq!(max_x - min_x + 1, 32);
            assert!(rgba.chunks_exact(4).any(|pixel| pixel == TRAY_LABEL_COLOR));
        }
    }

    #[test]
    fn tray_icon_uses_a_wider_font_for_values_that_leave_room() {
        for (remaining, expected_width) in [(Some(8.0), 20), (Some(99.0), 32), (Some(100.0), 32)] {
            let remaining = remaining.and_then(tray_percentage_for_test);
            let text = tray_percent_text(remaining, true);
            let compact_width = text == "100%";
            assert_eq!(tray_text_width(&text, compact_width), expected_width);

            let rgba = tray_icon_pixels(false, remaining, true, 20.0);
            assert_eq!(rgba.len(), 32 * 32 * 4);
            assert!((16..30).any(|y| {
                (0..32).any(|x| {
                    let index = ((y * 32 + x) * 4) as usize;
                    rgba[index + 3] != 0
                })
            }));
        }

        for remaining in 0..=100 {
            let remaining = tray_percentage_for_test(f64::from(remaining));
            let text = tray_percent_text(remaining, true);
            assert!(tray_text_width(&text, text == "100%") <= 32);
        }
    }

    #[test]
    fn tray_icon_pixels_align_to_the_native_16px_grid() {
        let rgba = tray_icon_pixels(false, tray_percentage_for_test(100.0), true, 20.0);
        for y in (0..32).step_by(2) {
            for x in (0..32).step_by(2) {
                let pixel = ((y * 32 + x) * 4) as usize;
                for y_offset in 0..2 {
                    for x_offset in 0..2 {
                        let aligned_pixel = (((y + y_offset) * 32 + x + x_offset) * 4) as usize;
                        assert_eq!(
                            &rgba[pixel..pixel + 4],
                            &rgba[aligned_pixel..aligned_pixel + 4]
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn tray_icons_distinguish_five_hour_and_weekly_periods() {
        let five_hour = tray_icon_pixels(false, None, false, 20.0);
        let weekly = tray_icon_pixels(true, None, false, 20.0);
        let label_bytes = 10 * 32 * 4;
        assert_ne!(&five_hour[..label_bytes], &weekly[..label_bytes]);
        assert!(five_hour[..label_bytes]
            .chunks_exact(4)
            .any(|pixel| pixel == TRAY_LABEL_COLOR));
        assert!(weekly[..label_bytes]
            .chunks_exact(4)
            .any(|pixel| pixel == TRAY_LABEL_COLOR));
    }

    #[test]
    fn invalid_legacy_field_preserves_close_choice_and_other_preferences() {
        let settings = decode_settings(serde_json::json!({ "uiScale": 123, "threshold5h": 17, "closeAction": "minimize", "ultraCompact": true, "soundEnabled": "invalid", "futureField": 1 })).unwrap();
        assert!(matches!(settings.close_action, CloseAction::Minimize));
        assert!(settings.ultra_compact);
        assert_eq!(settings.threshold_5h, 17.0);
        assert_eq!(settings.ui_scale, 100);
        assert!(!settings.sound_enabled);
    }

    #[test]
    fn atomic_preferences_replace_existing_file_and_preserve_valid_json() {
        let directory = std::env::temp_dir().join(format!(
            "wimu-settings-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = directory.join("settings.json");
        let mut settings = Settings::default();
        write_settings_path(&path, &settings).unwrap();
        settings.close_action = CloseAction::Minimize;
        write_settings_path(&path, &settings).unwrap();
        let restored =
            decode_settings(serde_json::from_slice(&fs::read(&path).unwrap()).unwrap()).unwrap();
        assert!(matches!(restored.close_action, CloseAction::Minimize));
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        fs::remove_file(path).unwrap();
        fs::remove_dir(directory).unwrap();
    }
}
