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
    // The variables `cc` consults for C++ flags, in its lookup order; the first one
    // set is the one it uses.
    let names = [
        format!("CXXFLAGS_{target}"),
        format!("CXXFLAGS_{}", target.replace('-', "_")),
        "TARGET_CXXFLAGS".to_string(),
        "CXXFLAGS".to_string(),
    ];
    for name in &names {
        println!("cargo:rerun-if-env-changed={name}");
    }
    if !target.ends_with("-windows-msvc") {
        return;
    }
    let flags = names
        .iter()
        .find_map(|name| std::env::var(name).ok())
        .unwrap_or_default();
    let unwinds = flags.split_whitespace().any(|flag| {
        flag.strip_prefix(['/', '-'])
            .is_some_and(|f| matches!(f, "EHsc" | "EHs" | "EHa" | "EHac"))
    });
    if !unwinds {
        panic!(
            "DuckDB must be compiled with /EHsc on {target}, or a failed statement can leave \
             it deadlocked. .cargo/config.toml sets CXXFLAGS_{} for this; run cargo from \
             inside the repository so it is read (C++ flags in use: {flags:?}).",
            target.replace('-', "_")
        );
    }
}
