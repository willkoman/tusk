use std::backtrace::Backtrace;
use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::Manager;

use crate::db::AppError;

const REPORT_FILE: &str = "last-crash.txt";
const MAX_FRONTEND_REPORT: usize = 128 * 1024;

fn report_path(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_config_dir()
        .map(|p| p.join(REPORT_FILE))
        .map_err(|e| AppError::new(format!("cannot resolve crash-report path: {e}")))
}

fn write_report(path: &PathBuf, report: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, report)
}

/// Persist Rust panics before the process exits. This cannot catch hard native
/// aborts/access violations, but it covers unwindable panics in commands and tasks.
pub(crate) fn install(app: &tauri::AppHandle) {
    let path = match report_path(app) {
        Ok(path) => path,
        Err(e) => {
            eprintln!("[tusk] crash reporting unavailable: {}", e.message);
            return;
        }
    };
    if let Some(parent) = path.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            eprintln!("[tusk] crash reporting unavailable: {e}");
            return;
        }
    }

    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let thread = std::thread::current();
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown".to_string());
        let report = format!(
            "Tusk native crash report\n\
             Version: {}\n\
             Unix time: {now}\n\
             Platform: {} {}\n\
             Thread: {}\n\
             Location: {location}\n\n\
             Panic: {info}\n\n\
             Backtrace:\n{}\n",
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH,
            thread.name().unwrap_or("unnamed"),
            Backtrace::force_capture(),
        );
        let _ = write_report(&path, &report);
        previous(info);
    }));
}

#[tauri::command]
pub(crate) fn crash_report_get(app: tauri::AppHandle) -> Result<Option<String>, AppError> {
    let path = report_path(&app)?;
    match fs::read_to_string(path) {
        Ok(report) => Ok(Some(report)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(AppError::new(format!("cannot read crash report: {e}"))),
    }
}

#[tauri::command]
pub(crate) fn crash_report_write(app: tauri::AppHandle, report: String) -> Result<(), AppError> {
    if report.len() > MAX_FRONTEND_REPORT {
        return Err(AppError::new("crash report is too large"));
    }
    let path = report_path(&app)?;
    write_report(&path, &report)
        .map_err(|e| AppError::new(format!("cannot write crash report: {e}")))
}

#[tauri::command]
pub(crate) fn crash_report_clear(app: tauri::AppHandle) -> Result<(), AppError> {
    let path = report_path(&app)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(AppError::new(format!("cannot clear crash report: {e}"))),
    }
}
