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

readonly PG_PORT="${TUSK_TEST_PG_PORT:-55432}"
readonly MY_PORT="${TUSK_TEST_MYSQL_PORT:-33306}"
readonly STARTUP_TIMEOUT_SECONDS="${TUSK_TEST_STARTUP_TIMEOUT:-120}"

# Digests were verified from local `docker image inspect` output. To update: pull
# the named tags, inspect RepoDigests, replace these values, then run this suite.
readonly PG_IMAGE="postgres:16-alpine@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229"
readonly MY_IMAGE="mysql:8@sha256:c36050afdca850f23cef85703f84c7531a5ae155a11b5ee1c60acb09937c4084"

cleanup() { docker rm -f tusk-it-pg tusk-it-mysql >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

if ! docker info >/dev/null 2>&1; then
  echo "Docker isn't running — start it, or run embedded-only with:" >&2
  echo "  cargo test --locked --manifest-path src-tauri/Cargo.toml --lib driver_conformance" >&2
  exit 1
fi

echo "Starting Postgres + MySQL containers…"
docker run -d --rm --name tusk-it-pg -e POSTGRES_PASSWORD=test -p "127.0.0.1:${PG_PORT}:5432" "$PG_IMAGE" >/dev/null
docker run -d --rm --name tusk-it-mysql -e MYSQL_ROOT_PASSWORD=test -e MYSQL_DATABASE=test -p "127.0.0.1:${MY_PORT}:3306" "$MY_IMAGE" >/dev/null

echo -n "Waiting for Postgres"
start=$SECONDS
until docker exec tusk-it-pg pg_isready --username=postgres --quiet >/dev/null 2>&1; do
  if (( SECONDS - start >= STARTUP_TIMEOUT_SECONDS )); then
    echo " timed out" >&2
    docker logs tusk-it-pg >&2 || true
    exit 1
  fi
  echo -n .
  sleep 1
done
echo " up"
echo -n "Waiting for MySQL"
# Must be a TCP check: during MySQL 8's init phase `mysqladmin ping` succeeds
# over the unix socket while port 3306 is still closed (the temp init server
# runs with networking off) — a socket-based wait lets the suite connect too
# early and die with "connection closed". Long-form options avoid MySQL's
# ambiguous short-option password syntax.
start=$SECONDS
until docker exec tusk-it-mysql mysql --protocol=TCP --host=127.0.0.1 --user=root --password=test --execute="SELECT 1" >/dev/null 2>&1; do
  if (( SECONDS - start >= STARTUP_TIMEOUT_SECONDS )); then
    echo " timed out" >&2
    docker logs tusk-it-mysql >&2 || true
    exit 1
  fi
  echo -n .
  sleep 2
done
echo " up"

echo "Running conformance suite (all 4 engines)…"
TUSK_TEST_PG_PORT=${PG_PORT} TUSK_TEST_MYSQL_PORT=${MY_PORT} \
  cargo test --locked --manifest-path src-tauri/Cargo.toml --lib driver_conformance -- --test-threads=1 "$@"
