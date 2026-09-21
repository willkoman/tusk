#!/usr/bin/env bash
# Cross-engine driver conformance suite (kept LF-only for Bash on Windows).
#
# Embedded engines (DuckDB, SQLite) always run. Postgres, MySQL and SQL Server run
# against throwaway Docker containers this script spins up and tears down. Requires
# Docker running.
#
# An OpenSSH container is started alongside them on a private Docker network, so the
# SSH-tunnel suite can reach Postgres the way a bastion would. The tunnel's in-process
# tests run without any of this; the container only adds the end-to-end path.
#
# Usage:  scripts/conformance.sh            # run everything
#         scripts/conformance.sh --nocapture
set -euo pipefail
cd "$(dirname "$0")/.."

readonly PG_PORT="${TUSK_TEST_PG_PORT:-55432}"
readonly MY_PORT="${TUSK_TEST_MYSQL_PORT:-33306}"
readonly SSH_PORT="${TUSK_TEST_SSH_PORT:-52222}"
readonly SSH_USER="tusk"
readonly SSH_PASSWORD="test"
readonly NETWORK="tusk-it-net"
readonly MS_PORT="${TUSK_TEST_MSSQL_PORT:-31433}"
# SQL Server enforces its own password complexity rules; keep this in sync with the
# `sa` password the suite connects with.
readonly MS_PASSWORD="${TUSK_TEST_MSSQL_PASSWORD:-Tusk_Test_2024!}"
# Three database servers now start together, so first-boot initialisation (MySQL
# datadir, SQL Server system databases) can take several minutes on a cold machine,
# and a cargo test build competes for the same cores: MySQL alone took over five
# minutes on a laptop, so the budget is fifteen.
readonly STARTUP_TIMEOUT_SECONDS="${TUSK_TEST_STARTUP_TIMEOUT:-900}"
# SQL Server's first boot upgrades master/model/msdb one version step at a time and is
# by far the slowest, so it gets its own budget rather than inflating everyone's.
readonly MSSQL_TIMEOUT_SECONDS="${TUSK_TEST_MSSQL_STARTUP_TIMEOUT:-600}"

# Digests were verified from local `docker image inspect` output. To update: pull
# the named tags, inspect RepoDigests, replace these values, then run this suite.
readonly PG_IMAGE="postgres:16-alpine@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229"
readonly MY_IMAGE="mysql:8@sha256:c36050afdca850f23cef85703f84c7531a5ae155a11b5ee1c60acb09937c4084"
readonly SSH_IMAGE="linuxserver/openssh-server@sha256:39ba37d50fdd6be1bf70644c871e5dcb9234ee79ac56424ea03ca08cadf1e7b0"
readonly MS_IMAGE="mcr.microsoft.com/mssql/server:2022-latest@sha256:97b448857967be55e005424a660056fe6d51814435804dc07e8f79f028bab5fb"

cleanup() {
  docker rm -f tusk-it-pg tusk-it-mysql tusk-it-mssql tusk-it-ssh >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

if ! docker info >/dev/null 2>&1; then
  echo "Docker isn't running — start it, or run embedded-only with:" >&2
  echo "  cargo test --locked --manifest-path src-tauri/Cargo.toml --lib driver_conformance" >&2
  exit 1
fi

echo "Starting Postgres + MySQL + SQL Server + OpenSSH containers…"
# A user-defined network gives the SSH container DNS for `tusk-it-pg`, which is the
# database address the tunnel test forwards to.
docker network create "$NETWORK" >/dev/null
docker run -d --rm --name tusk-it-pg --network "$NETWORK" -e POSTGRES_PASSWORD=test -p "127.0.0.1:${PG_PORT}:5432" "$PG_IMAGE" >/dev/null
docker run -d --rm --name tusk-it-mysql --network "$NETWORK" -e MYSQL_ROOT_PASSWORD=test -e MYSQL_DATABASE=test -p "127.0.0.1:${MY_PORT}:3306" "$MY_IMAGE" >/dev/null
docker run -d --rm --name tusk-it-mssql --network "$NETWORK" \
  -e ACCEPT_EULA=Y -e MSSQL_PID=Developer -e "MSSQL_SA_PASSWORD=${MS_PASSWORD}" \
  -p "127.0.0.1:${MS_PORT}:1433" "$MS_IMAGE" >/dev/null
docker run -d --rm --name tusk-it-ssh --network "$NETWORK" \
  -e PUID=1000 -e PGID=1000 -e PASSWORD_ACCESS=true \
  -e "USER_NAME=${SSH_USER}" -e "USER_PASSWORD=${SSH_PASSWORD}" \
  -p "127.0.0.1:${SSH_PORT}:2222" "$SSH_IMAGE" >/dev/null

# Poll one container's readiness command until it succeeds. The budget is per engine
# because they differ by an order of magnitude: SQL Server's first boot upgrades every
# system database, which takes minutes while three servers share the machine.
wait_for() {
  local label="$1" container="$2" budget="$3" interval="$4"
  shift 4
  echo -n "Waiting for ${label}"
  local start=$SECONDS
  until "$@" >/dev/null 2>&1; do
    if (( SECONDS - start >= budget )); then
      echo " timed out" >&2
      docker logs "$container" >&2 || true
      exit 1
    fi
    echo -n .
    sleep "$interval"
  done
  echo " up"
}

wait_for Postgres tusk-it-pg "$STARTUP_TIMEOUT_SECONDS" 1 \
  docker exec tusk-it-pg pg_isready --username=postgres --quiet
# Must be a TCP check: during MySQL 8's init phase `mysqladmin ping` succeeds
# over the unix socket while port 3306 is still closed (the temp init server
# runs with networking off) — a socket-based wait lets the suite connect too
# early and die with "connection closed". Long-form options avoid MySQL's
# ambiguous short-option password syntax.
wait_for MySQL tusk-it-mysql "$STARTUP_TIMEOUT_SECONDS" 2 \
  docker exec tusk-it-mysql mysql --protocol=TCP --host=127.0.0.1 --user=root --password=test --execute="SELECT 1"
# Watch the log rather than polling with sqlcmd: SQL Server's first boot upgrades every
# system database one version step at a time, and spawning a client process every couple
# of seconds through that adds load to the very thing being waited on.
wait_for "SQL Server" tusk-it-mssql "$MSSQL_TIMEOUT_SECONDS" 2 \
  bash -c 'docker logs tusk-it-mssql 2>&1 | grep -q "SQL Server is now ready for client connections"'
# The log line lands a moment before logins are accepted, so the database creation gets
# its own short retry. The UTF-8 collation lets ordinary `'…'` literals carry non-ASCII
# text, so the battery's unicode round-trip exercises Tusk's conversion rather than SQL
# Server's legacy codepage narrowing.
# MSYS_NO_PATHCONV keeps Git Bash on Windows from rewriting the in-container
# `/opt/...` path into a Windows one; it is inert everywhere else.
wait_for "SQL Server logins" tusk-it-mssql 180 2 \
  env MSYS_NO_PATHCONV=1 docker exec tusk-it-mssql /opt/mssql-tools18/bin/sqlcmd \
    -S 127.0.0.1 -U sa -P "${MS_PASSWORD}" -C -b \
    -Q "IF DB_ID('tusk_test') IS NULL CREATE DATABASE tusk_test COLLATE Latin1_General_100_CI_AS_SC_UTF8;"

echo -n "Waiting for sshd"
start=$SECONDS
until docker exec tusk-it-ssh sh -c 'pgrep -f "sshd.pam.*-D" >/dev/null' 2>/dev/null; do
  if (( SECONDS - start >= STARTUP_TIMEOUT_SECONDS )); then
    echo " timed out" >&2
    docker logs tusk-it-ssh >&2 || true
    exit 1
  fi
  echo -n .
  sleep 1
done
# The image ships `AllowTcpForwarding no`, which refuses direct-tcpip and makes the
# tunnel test fail as if the database were unreachable. Flip it and reload sshd.
docker exec -u root tusk-it-ssh sh -c \
  "sed -i 's/^AllowTcpForwarding no/AllowTcpForwarding yes/' /config/sshd/sshd_config && pkill -HUP -f 'sshd.pam.*-D'" >/dev/null
sleep 1
echo " up"

echo "Running conformance suite (all 5 engines)…"
TUSK_TEST_PG_PORT=${PG_PORT} TUSK_TEST_MYSQL_PORT=${MY_PORT} \
TUSK_TEST_MSSQL_PORT=${MS_PORT} TUSK_TEST_MSSQL_PASSWORD=${MS_PASSWORD} \
  cargo test --locked --manifest-path src-tauri/Cargo.toml --lib driver_conformance -- --test-threads=1 "$@"

echo "Running SSH tunnel suite (in-process + end-to-end through sshd)…"
TUSK_TEST_SSH_PORT=${SSH_PORT} TUSK_TEST_SSH_DB_HOST=tusk-it-pg TUSK_TEST_SSH_DB_PORT=5432 \
  TUSK_TEST_SSH_USER=${SSH_USER} TUSK_TEST_SSH_PASSWORD=${SSH_PASSWORD} \
  cargo test --locked --manifest-path src-tauri/Cargo.toml --lib ssh -- --test-threads=1 "$@"
