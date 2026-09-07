#!/usr/bin/env bash
#
# Roll a release-directory deployment back to an earlier release.
#
#   ./scripts/rollback.sh --host missiongo-prod --env-file /etc/missiongo/production.env --list
#   ./scripts/rollback.sh --host missiongo-prod --env-file /etc/missiongo/production.env
#
# deploy.sh keeps the snapshots and points `current` at the live one, which is
# what makes going back possible at all. Doing it by hand means composing four
# steps under pressure, so this does them in order and stops on the one that
# can actually lose data: rolling back past a migration.
#
# The database is NOT rolled back. Migrations only go forwards, so an older
# build meeting a newer schema is the real hazard here, not the code swap.

set -euo pipefail

NODE_IMAGE="node:22-bookworm-slim"
host=""
env_file=""
target_release=""
releases_dir="/opt/missiongo/releases"
current_link="/opt/missiongo/current"
data_dir="/srv/missiongo/data"
backups_dir="/srv/missiongo/backups"
public_url=""
list_only=0
skip_backup=0
allow_schema_gap=0

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/rollback.sh --host <ssh host> --env-file <path> [options]

  --host <ssh host>       SSH destination or ~/.ssh/config alias (required).
  --env-file <path>       Environment file ON THE SERVER, passed to docker compose (required).
  --to <release>          Release directory to go back to. Default: the one
                          immediately before the live release.
  --list                  Show the releases, their commits and which is live, then exit.
  --verify <url>          After switching, confirm /health reports the expected commit.
  --releases-dir <path>   Remote releases directory. Default: /opt/missiongo/releases.
  --current-link <path>   Remote "current" symlink. Default: /opt/missiongo/current.
  --data-dir <path>       Remote data directory. Default: /srv/missiongo/data.
  --backups-dir <path>    Remote backup directory. Default: /srv/missiongo/backups.
  --skip-backup           Do not back up before switching. Only for a rehearsal.
  --allow-schema-gap      Roll back even when the target predates migrations the
                          database has already applied. Read the warning first.
USAGE
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --host) host="${2-}"; shift 2 ;;
    --env-file) env_file="${2-}"; shift 2 ;;
    --to) target_release="${2-}"; shift 2 ;;
    --list) list_only=1; shift ;;
    --verify) public_url="${2-}"; shift 2 ;;
    --releases-dir) releases_dir="${2-}"; shift 2 ;;
    --current-link) current_link="${2-}"; shift 2 ;;
    --data-dir) data_dir="${2-}"; shift 2 ;;
    --backups-dir) backups_dir="${2-}"; shift 2 ;;
    --skip-backup) skip_backup=1; shift ;;
    --allow-schema-gap) allow_schema_gap=1; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1" >&2; usage ;;
  esac
done

[ -n "$host" ] && [ -n "$env_file" ] || usage

# Every value interpolated into a remote command is built here, not taken from
# the server or from untrusted input.
# shellcheck disable=SC2029
remote() { ssh "$host" "$@"; }

release_name_of() { basename "$1"; }

commit_of() {
  remote "sed -n 's/^commit=//p' '${releases_dir}/$1/RELEASE' 2>/dev/null | head -n 1"
}

# Releases are named with a sortable timestamp, so listing order is deploy order.
# Built with a read loop rather than mapfile: macOS still ships bash 3.2, and a
# deploy tool that only runs on the maintainer's newer shell is a trap.
releases=()
while IFS= read -r path; do
  [ -n "$path" ] || continue
  releases+=("$(release_name_of "$path")")
done <<EOF
$(remote "ls -1d '${releases_dir}'/*/ 2>/dev/null | sed 's:/\$::'")
EOF
[ "${#releases[@]}" -gt 0 ] || { echo "No releases under ${releases_dir} on ${host}." >&2; exit 1; }

live="$(release_name_of "$(remote "readlink -f '${current_link}'")")"

if [ "$list_only" -eq 1 ]; then
  echo "Releases on ${host} (oldest first):"
  for name in "${releases[@]}"; do
    commit="$(commit_of "$name")"
    marker=""
    [ "$name" = "$live" ] && marker="  <= live"
    printf '  %-42s %-9s%s\n' "$name" "${commit:0:7}" "$marker"
    [ -n "$commit" ] || printf '  %-42s %s\n' "" "(no RELEASE file: deployed before provenance existed)"
  done
  exit 0
fi

if [ -z "$target_release" ]; then
  previous=""
  for name in "${releases[@]}"; do
    [ "$name" = "$live" ] && break
    previous="$name"
  done
  [ -n "$previous" ] || { echo "The live release is the oldest one kept; nothing to roll back to." >&2; exit 1; }
  target_release="$previous"
fi

[ "$target_release" != "$live" ] || { echo "${target_release} is already live." >&2; exit 1; }
remote "test -d '${releases_dir}/${target_release}'" || { echo "No such release: ${target_release}" >&2; exit 1; }

target_commit="$(commit_of "$target_release")"
live_commit="$(commit_of "$live")"

echo "==> Rolling back"
echo "    from ${live}${live_commit:+  (${live_commit:0:7})}"
echo "    to   ${target_release}${target_commit:+  (${target_commit:0:7})}"
[ -n "$target_commit" ] || echo "    Note: that release predates provenance, so it cannot name its own commit."

# The hazard that is worth stopping for. Migrations run forwards only, so a
# build that does not know about a migration the database has already applied is
# reading a schema it was never written against -- an added column it will
# ignore, but a rebuilt table or a tightened constraint it will not survive.
echo "==> Checking the target against the schema the database is on"
target_migration="$(remote "grep -oE 'run\\([0-9]+, new Date' '${releases_dir}/${target_release}/services/server/src/storage/database.ts' 2>/dev/null | grep -oE '[0-9]+' | sort -n | tail -n 1")"
applied_migration="$(remote "sudo docker run --rm -v '${data_dir}:/data' ${NODE_IMAGE} node -e \"
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/data/missiongo.sqlite', { readOnly: true });
process.stdout.write(String(db.prepare('select max(version) as v from schema_migrations').get().v));
\" 2>/dev/null")"

if [ -z "$target_migration" ] || [ -z "$applied_migration" ]; then
  echo "    Could not read one of them (target='${target_migration}', applied='${applied_migration}')."
  [ "$allow_schema_gap" -eq 1 ] || {
    echo "Refusing to roll back blind. Pass --allow-schema-gap if you have checked by hand." >&2
    exit 1
  }
elif [ "$target_migration" -lt "$applied_migration" ]; then
  echo "    The database is on migration ${applied_migration}; that release only knows up to ${target_migration}." >&2
  echo "    Rolling back does not undo a migration, so this build would run against a schema" >&2
  echo "    it was never written for. Restore a backup from before ${applied_migration} instead," >&2
  echo "    or pass --allow-schema-gap if the difference is additive and you have read it." >&2
  [ "$allow_schema_gap" -eq 1 ] || exit 1
  echo "    --allow-schema-gap: continuing anyway."
else
  echo "    Target knows migration ${target_migration}, database is on ${applied_migration}. Safe."
fi

if [ "$skip_backup" -eq 1 ]; then
  echo "==> Skipping the backup (--skip-backup)"
else
  echo "==> Backing up into ${backups_dir} first"
  remote "sudo docker run --rm \
    -v '${data_dir}:/data' \
    -v '${backups_dir}:/backups' \
    -v '${releases_dir}/${live}/scripts:/scripts:ro' \
    ${NODE_IMAGE} \
    node /scripts/backup.mjs --out /backups --database /data/missiongo.sqlite --attachments /data/attachments"
fi

echo "==> Pointing ${current_link} at ${target_release}"
remote "sudo ln -sfn '${releases_dir}/${target_release}' '${current_link}'"

echo "==> Rebuilding from that snapshot"
remote "cd '${releases_dir}/${target_release}/deploy' && sudo env MISSIONGO_RELEASE='${target_commit:-unknown}' docker compose --env-file '${env_file}' up -d --build"
remote "sudo docker ps --format '    {{.Names}} | {{.Status}}'"

if [ -n "$public_url" ]; then
  echo "==> Verifying ${public_url%/}/health"
  live_now=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    live_now="$(curl -fsS "${public_url%/}/health" 2>/dev/null | sed -n 's/.*"release":"\([^"]*\)".*/\1/p')"
    [ -n "$live_now" ] && break
    sleep 3
  done
  if [ -z "$target_commit" ]; then
    echo "    Live release reports: ${live_now:-unreadable}. The target had no commit recorded, so this cannot be compared."
  elif [ "$live_now" = "$target_commit" ]; then
    echo "    Live release reports ${live_now:0:7} — the rollback is serving."
  else
    echo "    Expected ${target_commit:0:7}, got ${live_now:-nothing}." >&2
    exit 1
  fi
fi

echo "==> Done. ${target_release} is live."
echo "    The database was not rolled back; only the code was."
