#!/usr/bin/env bash
# Cross-engine driver conformance suite (kept LF-only for Bash on Windows).
#
# Embedded engines (DuckDB, SQLite) always run. Postgres + MySQL run against throwaway
# Docker containers this script spins up and tears down. Requires Docker running.
#
# Usage:  scripts/conformance.sh            # run everything
#         scripts/conformance.sh --nocapture
set -euo pipefail
cd "$(dirname "$0")/.."

PG_PORT=55432
MY_PORT=33306

cleanup() { docker rm -f tusk-it-pg tusk-it-mysql >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

if ! docker info >/dev/null 2>&1; then
  echo "Docker isn't running — start it, or run embedded-only with:" >&2
  echo "  cargo test --manifest-path src-tauri/Cargo.toml --lib driver_conformance" >&2
  exit 1
fi

echo "Starting Postgres + MySQL containers…"
docker run -d --rm --name tusk-it-pg -e POSTGRES_PASSWORD=test -p ${PG_PORT}:5432 postgres:16-alpine >/dev/null
docker run -d --rm --name tusk-it-mysql -e MYSQL_ROOT_PASSWORD=test -e MYSQL_DATABASE=test -p ${MY_PORT}:3306 mysql:8 >/dev/null

echo -n "Waiting for Postgres"
until docker exec tusk-it-pg pg_isready -U postgres >/dev/null 2>&1; do echo -n .; sleep 1; done
echo " up"
echo -n "Waiting for MySQL"
# Must be a TCP check: during MySQL 8's init phase `mysqladmin ping` succeeds
# over the unix socket while port 3306 is still closed (the temp init server
# runs with networking off) — a socket-based wait lets the suite connect too
# early and die with "connection closed".
until docker exec tusk-it-mysql mysql -h127.0.0.1 -uroot -ptest -e "SELECT 1" >/dev/null 2>&1; do echo -n .; sleep 2; done
echo " up"

echo "Running conformance suite (all 4 engines)…"
TUSK_TEST_PG_PORT=${PG_PORT} TUSK_TEST_MYSQL_PORT=${MY_PORT} \
  cargo test --manifest-path src-tauri/Cargo.toml --lib driver_conformance -- --test-threads=1 "$@"
