#!/usr/bin/env bash
# Fail unless the most recent libduckdb-sys build under a cargo profile directory
# compiled DuckDB with /EHsc (see .cargo/config.toml and src-tauri/build.rs).
#
#   scripts/check-duckdb-ehsc.sh src-tauri/target/release [x86_64-pc-windows-msvc]
#
# The `cc` crate prints every environment variable it reads into the build script's
# `output` file, so the line below is the flag set that compiled the DuckDB actually
# linked into the binary, read straight from the build rather than from the config
# that was supposed to produce it.
set -euo pipefail

profile_dir="${1:?usage: check-duckdb-ehsc.sh <cargo profile dir> [target triple]}"
target="${2:-x86_64-pc-windows-msvc}"
expected="CXXFLAGS_${target//[-.]/_} = Some(/EHsc)"

# Cargo has two build-directory layouts. The original keeps a build script's stdout in
# `build/libduckdb-sys-<hash>/output`; the one stable cargo uses since Rust 1.100 keeps
# it in `build/libduckdb-sys/<hash>/run/stdout`. Search both rather than pin one: when
# only the old glob was searched, this check failed every Windows job, and a failed job
# saves no Rust cache, so every Windows release compiled from scratch.
mapfile -t outputs < <(find "$profile_dir/build" -type f \
  \( -path "*/libduckdb-sys-*/output" -o -path "*/libduckdb-sys/*/run/stdout" \) 2>/dev/null)
if ((${#outputs[@]} == 0)); then
  echo "::error::no libduckdb-sys build output under $profile_dir/build" >&2
  exit 1
fi
# A restored cache can hold an older build directory beside the current one.
newest="$(ls -t "${outputs[@]}" | head -n 1)"
if grep -qF "$expected" "$newest"; then
  echo "$newest: $expected"
else
  echo "::error::DuckDB was compiled without /EHsc; a failed statement can deadlock it. Expected \`$expected\` in $newest:" >&2
  # cc prints its lookup once per compiled file; one copy of each line is enough.
  grep -F 'CXXFLAGS' "$newest" | grep -vF 'rerun-if-env-changed' | sort -u >&2 || true
  exit 1
fi
