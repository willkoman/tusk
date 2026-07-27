use std::backtrace::Backtrace;
use std::fs::{self, File, Metadata};
use std::io::{ErrorKind, Read, Write};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::Manager;

use crate::db::AppError;

const REPORT_FILE: &str = "last-crash.txt";
const MAX_FRONTEND_REPORT: usize = 128 * 1024;
const TRUNCATED: &str = "\n[crash report truncated]\n";

fn report_path(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_config_dir()
        .map(|p| p.join(REPORT_FILE))
        .map_err(|e| AppError::new(format!("cannot resolve crash-report path: {e}")))
}

#[cfg(windows)]
fn is_reparse(meta: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse(_: &Metadata) -> bool {
    false
}

fn regular_report(path: &PathBuf) -> std::io::Result<Option<Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() || is_reparse(&meta) || !meta.is_file() => {
            Err(std::io::Error::new(
                ErrorKind::InvalidData,
                "crash-report path is not a regular file",
            ))
        }
        Ok(meta) => Ok(Some(meta)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn bounded_report(mut report: String) -> String {
    if report.len() <= MAX_FRONTEND_REPORT {
        return report;
    }
    let limit = MAX_FRONTEND_REPORT.saturating_sub(TRUNCATED.len());
    let mut end = limit;
    while !report.is_char_boundary(end) {
        end -= 1;
    }
    report.truncate(end);
    report.push_str(TRUNCATED);
    report
}

fn set_restrictive_permissions(_file: &File) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        _file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn write_report(path: &PathBuf, report: &str) -> std::io::Result<()> {
    if report.len() > MAX_FRONTEND_REPORT {
        return Err(std::io::Error::new(
            ErrorKind::InvalidInput,
            "crash report is too large",
        ));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
        regular_report(path)?;
        let mut temp = tempfile::NamedTempFile::new_in(parent)?;
        set_restrictive_permissions(temp.as_file())?;
        temp.write_all(report.as_bytes())?;
        temp.as_file_mut().sync_all()?;
        temp.persist(path).map_err(|e| e.error)?;
        #[cfg(unix)]
        File::open(parent)?.sync_all()?;
        return Ok(());
    }
    Err(std::io::Error::new(
        ErrorKind::InvalidInput,
        "crash-report path has no parent",
    ))
}

fn read_report(path: &PathBuf) -> std::io::Result<Option<String>> {
    let Some(meta) = regular_report(path)? else {
        return Ok(None);
    };
    if meta.len() > MAX_FRONTEND_REPORT as u64 {
        return Err(std::io::Error::new(
            ErrorKind::InvalidData,
            "crash report is too large",
        ));
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    File::open(path)?
        .take(MAX_FRONTEND_REPORT as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_FRONTEND_REPORT {
        return Err(std::io::Error::new(
            ErrorKind::InvalidData,
            "crash report is too large",
        ));
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| std::io::Error::new(ErrorKind::InvalidData, "crash report is not valid UTF-8"))
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
        let report = bounded_report(format!(
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
        ));
        let _ = write_report(&path, &report);
        previous(info);
    }));
}

#[tauri::command]
pub(crate) fn crash_report_get(app: tauri::AppHandle) -> Result<Option<String>, AppError> {
    let path = report_path(&app)?;
    match read_report(&path) {
        Ok(report) => Ok(report),
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
    // remove_file unlinks a symlink/reparse point itself; it does not remove its target.
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(AppError::new(format!("cannot clear crash report: {e}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_reports_are_utf8_safely_bounded() {
        let report = bounded_report("é".repeat(MAX_FRONTEND_REPORT));
        assert!(report.len() <= MAX_FRONTEND_REPORT);
        assert!(report.ends_with(TRUNCATED));
        assert!(report.is_char_boundary(report.len()));
    }

    #[test]
    fn report_reads_and_writes_enforce_size_limit() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(REPORT_FILE);
        write_report(&path, "small").unwrap();
        assert_eq!(read_report(&path).unwrap().as_deref(), Some("small"));
        assert!(write_report(&path, &"x".repeat(MAX_FRONTEND_REPORT + 1)).is_err());
        fs::write(&path, vec![b'x'; MAX_FRONTEND_REPORT + 1]).unwrap();
        assert!(read_report(&path).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn report_reads_and_writes_refuse_links_but_clear_unlinks_them() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target");
        fs::write(&target, "keep").unwrap();
        let path = temp.path().join(REPORT_FILE);
        symlink(&target, &path).unwrap();
        assert!(read_report(&path).is_err());
        assert!(write_report(&path, "replace").is_err());
        fs::remove_file(&path).unwrap();
        assert_eq!(fs::read_to_string(target).unwrap(), "keep");
    }
}
