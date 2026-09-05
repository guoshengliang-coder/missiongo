#!/usr/bin/env bash
#
# Deploy MissionGo to a release-directory host.
#
#   ./scripts/deploy.sh --host missiongo-prod --env-file /etc/missiongo/production.env
#
# Run this from a workstation checkout, not on the server. The deployment keeps
# timestamped source snapshots under <releases>/ and points a `current` symlink
# at the live one, so this pushes a new snapshot rather than pulling a branch.
#
# The backup runs in a throwaway node container, so the server needs neither Node
# nor a copy of this repository's scripts already in place. That also lets the
# first deployment back up with the scripts it is currently pushing.
#
# Excludes are explicit because rsync does not read .gitignore, and does not read
# .git/info/exclude at all — a locally ignored directory reaches the server
# otherwise.

set -euo pipefail

NODE_IMAGE="node:22-bookworm-slim"
host=""
env_file=""
label="deploy"
releases_dir="/opt/missiongo/releases"
current_link="/opt/missiongo/current"
data_dir="/srv/missiongo/data"
backups_dir="/srv/missiongo/backups"
public_url=""
verify_host=""
keep=10
skip_backup=0
verify=0

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/deploy.sh --host <ssh host> --env-file <remote env file> [options]

  --host <ssh host>       SSH destination or ~/.ssh/config alias (required).
  --env-file <path>       Environment file ON THE SERVER, passed to docker compose (required).
  --label <text>          Suffix for the release directory name. Default: deploy.
  --releases-dir <path>   Remote releases directory. Default: /opt/missiongo/releases.
  --current-link <path>   Remote "current" symlink. Default: /opt/missiongo/current.
  --data-dir <path>       Remote data directory. Default: /srv/missiongo/data.
  --backups-dir <path>    Remote backup directory. Default: /srv/missiongo/backups.
  --keep <n>              Release directories to retain, newest first. Default: 10.
                          0 keeps everything. The live release is never removed.
  --skip-backup           Deploy without backing up first. Not recommended.
  --verify <origin url>   After deploying, check the release is live and that a
                          forged X-Forwarded-For cannot reset the sign-in rate
                          limit. Point this at the ORIGIN, not at a CDN edge:
                          the check makes 11 failed sign-in attempts, and it
                          should burn the calling address's own rate-limit
                          bucket rather than one shared by real visitors.
  --verify-host <host>    Host header to send while verifying, for an origin
                          addressed by IP behind a CDN. Certificate validation
                          is skipped for those requests, since a certificate
                          issued for the hostname cannot match the IP.
USAGE
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --host) host="${2-}"; shift 2 ;;
    --env-file) env_file="${2-}"; shift 2 ;;
    --label) label="${2-}"; shift 2 ;;
    --releases-dir) releases_dir="${2-}"; shift 2 ;;
    --current-link) current_link="${2-}"; shift 2 ;;
    --data-dir) data_dir="${2-}"; shift 2 ;;
    --backups-dir) backups_dir="${2-}"; shift 2 ;;
    --keep) keep="${2-}"; shift 2 ;;
    --skip-backup) skip_backup=1; shift ;;
    --verify) public_url="${2-}"; verify=1; shift 2 ;;
    --verify-host) verify_host="${2-}"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done

[ -n "$host" ] && [ -n "$env_file" ] || usage
case "$keep" in ""|*[!0-9]*) echo "--keep takes a non-negative integer." >&2; exit 1 ;; esac

cd "$(dirname "$0")/.."
[ -f deploy/docker-compose.yml ] || { echo "Run this from a MissionGo checkout." >&2; exit 1; }
command -v rsync >/dev/null || { echo "rsync is required." >&2; exit 1; }

# Paths are expanded here, on the client, which is intended: every value
# interpolated into a remote command is built by this script, not taken from
# the server or from untrusted input.
# shellcheck disable=SC2029
remote() { ssh "$host" "$@"; }

release="$(remote date +%Y%m%d-%H%M%S)-${label}"
target="${releases_dir}/${release}"

echo "==> Pushing ${release}"
rsync -az --delete \
  --exclude='.git' --exclude='.private' \
  --exclude='node_modules' --exclude='dist' --exclude='build' \
  --exclude='.gradle' --exclude='.kotlin' --exclude='coverage' \
  --exclude='.env' --exclude='data' \
  --exclude='._*' --exclude='.DS_Store' --exclude='*.tsbuildinfo' \
  --rsync-path='sudo rsync' \
  ./ "${host}:${target}/"

# The APK is git-ignored, so a fresh clone cannot supply it. Losing it would
# silently break the fixed download link that the Android app relies on.
if ! remote "sudo test -s '${target}/apps/web/public/downloads/missiongo-android-latest.apk'"; then
  echo "The release has no Android APK at apps/web/public/downloads/." >&2
  echo "Run npm run publish:android-internal first, or restore it from the current release." >&2
  exit 1
fi

if [ "$skip_backup" -eq 1 ]; then
  echo "==> Skipping the backup (--skip-backup)"
else
  echo "==> Backing up into ${backups_dir}"
  # /data is mounted read-write on purpose: backup.mjs opens the database
  # read-only, but a WAL reader still writes the -shm file, and a read-only
  # mount fails with "attempt to write a readonly database".
  remote "sudo docker run --rm \
    -v '${data_dir}:/data' \
    -v '${backups_dir}:/backups' \
    -v '${target}/scripts:/scripts:ro' \
    ${NODE_IMAGE} \
    node /scripts/backup.mjs --out /backups --database /data/missiongo.sqlite --attachments /data/attachments"
  echo "    Copy this off the machine; a backup beside the data does not survive a lost disk."
fi

echo "==> Rebuilding and restarting"
remote "cd '${target}/deploy' && sudo docker compose --env-file '${env_file}' up -d --build"

echo "==> Pointing ${current_link} at the new release"
remote "sudo ln -sfn '${target}' '${current_link}'"
remote "sudo docker ps --format '    {{.Names}} | {{.Status}}'"

if [ "$keep" -gt 0 ]; then
  echo "==> Keeping the newest ${keep} releases"
  # Resolve the symlink first and skip that directory explicitly: the live
  # release is normally the newest, but a rollback points `current` at an older
  # one, and pruning by age alone would then delete what is actually running.
  remote "live=\$(readlink -f '${current_link}'); \
    ls -1d '${releases_dir}'/*/ 2>/dev/null | sed 's:/\$::' | sort -r | tail -n +$((keep + 1)) | \
    while read -r dir; do \
      [ \"\$dir\" = \"\$live\" ] && continue; \
      sudo rm -rf \"\$dir\" && echo \"    removed \$(basename \"\$dir\")\"; \
    done"
fi

if [ "$verify" -eq 1 ]; then
  origin="${public_url%/}"
  echo "==> Verifying ${origin}"

  # An origin addressed by IP cannot present a certificate matching it, so
  # -k goes with --verify-host. The destination is still the address given here.
  curl_args=(--max-time 15)
  [ -n "$verify_host" ] && curl_args+=(-k -H "Host: ${verify_host}")

  headers="$(curl -sSI "${curl_args[@]}" "${origin}/api/v1/auth/session" || true)"
  if grep -qi '^x-frame-options: DENY' <<<"$headers"; then
    echo "    The new build is serving its own security headers."
  else
    echo "    Deployment finished, but verification could not confirm it." >&2
    echo "    No X-Frame-Options came back from ${origin}." >&2
    exit 1
  fi

  codes=""
  for i in $(seq 1 11); do
    codes="$codes $(curl -s -o /dev/null -w '%{http_code}' "${curl_args[@]}" \
      -X POST "${origin}/api/v1/auth/login" \
      -H 'Content-Type: application/json' \
      -H "X-Forwarded-For: 203.0.113.$i" \
      -d '{"username":"deploy-check","password":"deploy-check"}')"
  done
  echo "    Sign-in attempts with rotating forged addresses:$codes"
  case "$codes" in
    *429*) echo "    Rate limiting holds against forged addresses." ;;
    *) echo "    Expected a 429 by the 11th attempt. TRUST_PROXY is trusting too much." >&2; exit 1 ;;
  esac
fi

echo "==> Done"
