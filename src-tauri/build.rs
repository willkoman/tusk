fn main() {
    require_msvc_unwinding();
    tauri_build::build()
}

/// Refuse to build for Windows unless DuckDB's C++ is compiled with C++ unwinding.
///
/// `.cargo/config.toml` hands `/EHsc` to libduckdb-sys through `CXXFLAGS_<target>`.
/// Cargo only reads that file when it runs inside the repository, and without the
/// flag MSVC skips destructors while unwinding, so DuckDB keeps its internal locks
/// after an ordinary error and the next statement can block forever. Failing the
/// build here is better than shipping that.
fn require_msvc_unwinding() {
    let target = std::env::var("TARGET").unwrap_or_default();
    let host = std::env::var("HOST").unwrap_or_default();
    let names = cxxflags_names(&target, &host);
    for name in &names {
        println!("cargo:rerun-if-env-changed={name}");
    }
    if !target.ends_with("-windows-msvc") {
        return;
    }
    let flags = cxxflags(&names, |name| std::env::var(name).ok());
    if !msvc_unwinds(&flags) {
        panic!(
            "DuckDB must be compiled with /EHsc on {target}, or a failed statement can leave \
             it deadlocked. .cargo/config.toml sets CXXFLAGS_<target> for the x86_64, i686, \
             aarch64 and arm64ec MSVC targets; run cargo from inside the repository so it is \
             read, or set CXXFLAGS_{} = \"/EHsc\" (C++ flags in use: {flags:?}).",
            target.replace(['-', '.'], "_")
        );
    }
}

/// The variables the `cc` crate (1.2.x, `Build::target_envs`) consults for C++ flags,
/// most specific first: `HOST_CXXFLAGS` for a native build and `TARGET_CXXFLAGS` for a
/// cross build, never both.
fn cxxflags_names(target: &str, host: &str) -> [String; 4] {
    let kind = if host == target { "HOST" } else { "TARGET" };
    [
        format!("CXXFLAGS_{target}"),
        format!("CXXFLAGS_{}", target.replace(['-', '.'], "_")),
        format!("{kind}_CXXFLAGS"),
        "CXXFLAGS".to_string(),
    ]
}

/// The flags `cc` passes, as its `Build::envflags` assembles them: every one of
/// `names` that is set contributes, least specific first, so a later (more specific)
/// variable's flags follow — and on MSVC override — an earlier one's. A token is
/// unquoted the way `CC_SHELL_ESCAPED_FLAGS` would, which only matters for a quoted
/// `/EH` flag.
fn cxxflags(names: &[String], var: impl Fn(&str) -> Option<String>) -> Vec<String> {
    names
        .iter()
        .rev()
        .filter_map(|name| var(name))
        .flat_map(|value| {
            value
                .split_ascii_whitespace()
                .map(|token| token.trim_matches(['"', '\'']).to_string())
                .collect::<Vec<_>>()
        })
        .collect()
}

/// Whether MSVC compiles C++ exceptions with unwinding under `flags`. MSVC reads
/// `/EH` options left to right, each letter optionally followed by `-` to turn it
/// off (`/EHsc`, `/EHs-c-`, `/EHa`), so the last word on `s` / `a` wins.
fn msvc_unwinds(flags: &[String]) -> bool {
    let (mut sync, mut asynchronous) = (false, false);
    for flag in flags {
        let Some(letters) = flag
            .strip_prefix(['/', '-'])
            .and_then(|f| f.strip_prefix("EH"))
        else {
            continue;
        };
        let mut chars = letters.chars().peekable();
        while let Some(letter) = chars.next() {
            let on = chars.next_if_eq(&'-').is_none();
            match letter {
                's' => sync = on,
                'a' => asynchronous = on,
                _ => {}
            }
        }
    }
    sync || asynchronous
}
