#!/usr/bin/env bash
# Cross-engine driver conformance suite (kept LF-only for Bash on Windows).
#
# Embedded engines (DuckDB, SQLite) always run. Postgres + MySQL run against throwaway
# Docker containers this script spins up and tears down. Requires Docker running.
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
readonly STARTUP_TIMEOUT_SECONDS="${TUSK_TEST_STARTUP_TIMEOUT:-120}"

# Digests were verified from local `docker image inspect` output. To update: pull
# the named tags, inspect RepoDigests, replace these values, then run this suite.
readonly PG_IMAGE="postgres:16-alpine@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229"
readonly MY_IMAGE="mysql:8@sha256:c36050afdca850f23cef85703f84c7531a5ae155a11b5ee1c60acb09937c4084"
readonly SSH_IMAGE="linuxserver/openssh-server@sha256:39ba37d50fdd6be1bf70644c871e5dcb9234ee79ac56424ea03ca08cadf1e7b0"

cleanup() {
  docker rm -f tusk-it-pg tusk-it-mysql tusk-it-ssh >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

if ! docker info >/dev/null 2>&1; then
  echo "Docker isn't running — start it, or run embedded-only with:" >&2
  echo "  cargo test --locked --manifest-path src-tauri/Cargo.toml --lib driver_conformance" >&2
  exit 1
fi

echo "Starting Postgres + MySQL + OpenSSH containers…"
# A user-defined network gives the SSH container DNS for `tusk-it-pg`, which is the
# database address the tunnel test forwards to.
docker network create "$NETWORK" >/dev/null
docker run -d --rm --name tusk-it-pg --network "$NETWORK" -e POSTGRES_PASSWORD=test -p "127.0.0.1:${PG_PORT}:5432" "$PG_IMAGE" >/dev/null
docker run -d --rm --name tusk-it-mysql --network "$NETWORK" -e MYSQL_ROOT_PASSWORD=test -e MYSQL_DATABASE=test -p "127.0.0.1:${MY_PORT}:3306" "$MY_IMAGE" >/dev/null
docker run -d --rm --name tusk-it-ssh --network "$NETWORK" \
  -e PUID=1000 -e PGID=1000 -e PASSWORD_ACCESS=true \
  -e "USER_NAME=${SSH_USER}" -e "USER_PASSWORD=${SSH_PASSWORD}" \
  -p "127.0.0.1:${SSH_PORT}:2222" "$SSH_IMAGE" >/dev/null

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

echo "Running conformance suite (all 4 engines)…"
TUSK_TEST_PG_PORT=${PG_PORT} TUSK_TEST_MYSQL_PORT=${MY_PORT} \
  cargo test --locked --manifest-path src-tauri/Cargo.toml --lib driver_conformance -- --test-threads=1 "$@"

echo "Running SSH tunnel suite (in-process + end-to-end through sshd)…"
TUSK_TEST_SSH_PORT=${SSH_PORT} TUSK_TEST_SSH_DB_HOST=tusk-it-pg TUSK_TEST_SSH_DB_PORT=5432 \
  TUSK_TEST_SSH_USER=${SSH_USER} TUSK_TEST_SSH_PASSWORD=${SSH_PASSWORD} \
  cargo test --locked --manifest-path src-tauri/Cargo.toml --lib ssh -- --test-threads=1 "$@"
