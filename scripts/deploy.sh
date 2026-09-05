#!/usr/bin/env bash
#
# Update a MissionGo deployment: back up, pull, rebuild, and check it came back.
# Run this on the deployment host, from the repository checkout that sits next
# to the private environment file.
#
#   ./scripts/deploy.sh --env-file /path/to/private.env
#
# The backup runs in a throwaway node container rather than through npm, because
# the host does not need Node installed and the server image does not carry
# scripts/. That also means the first upgrade can back up with the scripts it
# just pulled, instead of needing them to already be inside the running image.

set -euo pipefail

NODE_IMAGE="node:22-bookworm-slim"
env_file=""
backup_dir=""
skip_backup=0
verify=0

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/deploy.sh --env-file <file> [options]

  --env-file <file>    Private environment file passed to docker compose (required).
  --backup-dir <dir>   Where to write the backup. Defaults to <MISSIONGO_DATA_PATH>/backups.
  --skip-backup        Deploy without taking a backup first. Not recommended.
  --verify             After deploying, confirm the sign-in rate limit cannot be
                       bypassed with a forged X-Forwarded-For header. This makes
                       11 failed sign-in attempts, which locks this machine's
                       public address out of sign-in for 15 minutes.
USAGE
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) env_file="${2-}"; shift 2 ;;
    --backup-dir) backup_dir="${2-}"; shift 2 ;;
    --skip-backup) skip_backup=1; shift ;;
    --verify) verify=1; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done

[ -n "$env_file" ] || usage
[ -f "$env_file" ] || { echo "Environment file not found: $env_file" >&2; exit 1; }

cd "$(dirname "$0")/.."
[ -f deploy/docker-compose.yml ] || { echo "Run this from a MissionGo checkout." >&2; exit 1; }
command -v docker >/dev/null || { echo "docker is required." >&2; exit 1; }

# Read one value from the environment file without sourcing it, so a stray
# command substitution in there cannot run.
read_env() {
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$env_file" | tail -1 | sed 's/^"\(.*\)"$/\1/; s/^'"'"'\(.*\)'"'"'$/\1/'
}

data_path="$(read_env MISSIONGO_DATA_PATH)"
bind_port="$(read_env MISSIONGO_BIND_PORT)"
public_origin="$(read_env MISSIONGO_PUBLIC_ORIGIN)"
bind_port="${bind_port:-8788}"

[ -n "$data_path" ] || { echo "MISSIONGO_DATA_PATH is not set in $env_file" >&2; exit 1; }
[ -d "$data_path" ] || { echo "Data directory not found: $data_path" >&2; exit 1; }

compose() { docker compose --env-file "$env_file" -f deploy/docker-compose.yml "$@"; }

echo "==> Pulling the latest revision"
git pull --ff-only

if [ "$skip_backup" -eq 1 ]; then
  echo "==> Skipping the backup (--skip-backup)"
else
  backup_dir="${backup_dir:-$data_path/backups}"
  mkdir -p "$backup_dir"
  echo "==> Backing up into $backup_dir"
  # Match the data directory's owner so the archive is not left root-owned.
  owner="$(stat -c '%u:%g' "$data_path" 2>/dev/null || stat -f '%u:%g' "$data_path")"
  # /data is mounted read-write on purpose. backup.mjs opens the database
  # read-only, but a WAL reader still has to write the -shm file, and a read-only
  # mount fails with "attempt to write a readonly database".
  docker run --rm \
    --user "$owner" \
    -v "$data_path:/data" \
    -v "$backup_dir:/backups" \
    -v "$PWD/scripts:/scripts:ro" \
    "$NODE_IMAGE" \
    node /scripts/backup.mjs --out /backups --database /data/missiongo.sqlite --attachments /data/attachments
  echo "    Copy this off the machine; a backup beside the data does not survive a lost disk."
fi

echo "==> Rebuilding and restarting"
compose up -d --build

echo "==> Waiting for the service to report healthy"
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${bind_port}/health"; then
    echo "    Healthy."
    break
  fi
  sleep 2
done
curl -fsS -o /dev/null "http://127.0.0.1:${bind_port}/health" || {
  echo "Service did not become healthy. Recent logs:" >&2
  compose logs --tail 40 >&2
  exit 1
}

if [ "$verify" -eq 1 ]; then
  [ -n "$public_origin" ] || { echo "MISSIONGO_PUBLIC_ORIGIN is not set, cannot verify." >&2; exit 1; }
  echo "==> Verifying the sign-in rate limit ignores a forged X-Forwarded-For"
  codes=""
  for i in $(seq 1 11); do
    codes="$codes $(curl -s -o /dev/null -w '%{http_code}' \
      -X POST "${public_origin%/}/api/v1/auth/login" \
      -H 'Content-Type: application/json' \
      -H "X-Forwarded-For: 203.0.113.$i" \
      -d '{"username":"deploy-check","password":"deploy-check"}')"
  done
  echo "    Responses:$codes"
  case "$codes" in
    *429*) echo "    Rate limiting holds against forged addresses." ;;
    *) echo "    Expected a 429 by the 11th attempt. TRUST_PROXY is trusting too much." >&2; exit 1 ;;
  esac
fi

echo "==> Done"
