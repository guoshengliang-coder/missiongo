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
#
# The public Android download is served by the host proxy from its own directory,
# outside the release snapshots, so a deploy has to publish the APK there as well
# or the download link keeps serving the previous build.

set -euo pipefail

NODE_IMAGE="node:22-bookworm-slim"
host=""
env_file=""
label="deploy"
releases_dir="/opt/missiongo/releases"
current_link="/opt/missiongo/current"
data_dir="/srv/missiongo/data"
backups_dir="/srv/missiongo/backups"
downloads_dir="/srv/missiongo/releases"
public_url=""
verify_host=""
keep=10
skip_backup=0
publish_apk=1
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
  --downloads-dir <path>  Remote directory the host proxy serves the public APK
                          download from, holding the versioned APKs and the
                          missiongo-android-latest.apk symlink that names the
                          live one. Default: /srv/missiongo/releases.
  --keep <n>              Release directories and published APKs to retain,
                          newest first. Default: 10. 0 keeps everything. The
                          live release and the published APK are never removed.
  --skip-backup           Deploy without backing up first. Not recommended.
  --no-publish-apk        Leave the host download directory alone, for a
                          deployment that serves the APK from the image instead.
  --verify <url>          After deploying, check the release is live and that a
                          forged X-Forwarded-For cannot reset the sign-in rate
                          limit. The check makes 11 failed sign-in attempts, so
                          aim it where that burns the caller's own rate-limit
                          bucket. Behind a CDN that rewrites X-Forwarded-For to
                          the real visitor address, the public hostname does
                          that. Behind one that only appends, the application
                          attributes the attempts to the CDN edge and locks out
                          every visitor sharing it, so use the origin instead.
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
    --downloads-dir) downloads_dir="${2-}"; shift 2 ;;
    --keep) keep="${2-}"; shift 2 ;;
    --skip-backup) skip_backup=1; shift ;;
    --no-publish-apk) publish_apk=0; shift ;;
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

local_apk="apps/web/public/downloads/missiongo-android-latest.apk"
local_apk_meta="apps/web/public/downloads/missiongo-android-latest.release"
apk_link="${downloads_dir}/missiongo-android-latest.apk"

# macOS ships shasum without sha256sum; a minimal Linux host ships the reverse.
sha256_of() {
  if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{print $1}'
}

# Paths are expanded here, on the client, which is intended: every value
# interpolated into a remote command is built by this script, not taken from
# the server or from untrusted input.
# shellcheck disable=SC2029
remote() { ssh "$host" "$@"; }

# Settle the APK before anything is pushed. It is all local, and a stale build
# is better caught now than after a release directory exists on the server.
#
# The APK is git-ignored, so a fresh clone cannot supply it, and rsync sends
# whatever this checkout has. A missing one is not an error: the previous build
# stays downloadable, and only this deploy declines to touch it.
if [ ! -s "$local_apk" ]; then
  echo "Note: this checkout carries no Android APK under apps/web/public/downloads/." >&2
  if [ "$publish_apk" -eq 1 ]; then
    publish_apk=0
    echo "      Leaving ${apk_link} on the build it already serves." >&2
  fi
  echo "      Run npm run publish:android-internal to ship a new one." >&2
fi

if [ "$publish_apk" -eq 1 ]; then
  # The APK has a fixed name, so only the metadata beside it knows which version
  # it holds. Refuse rather than invent a name: publishing the download under a
  # version it is not is worse than stopping before the push.
  [ -s "$local_apk_meta" ] || {
    echo "No build metadata beside the APK: ${local_apk_meta}" >&2
    echo "Run npm run publish:android-internal to rebuild and record it." >&2
    exit 1
  }

  # Parsed field by field rather than sourced: this file is generated, but a
  # deploy script should not execute a file just to read four values out of it.
  apk_field() { sed -n "s/^$1=//p" "$local_apk_meta" | head -n 1; }
  apk_version_name="$(apk_field version_name)"
  apk_version_code="$(apk_field version_code)"
  apk_meta_sha="$(apk_field sha256)"

  case "$apk_version_name" in ""|*[!0-9.]*) echo "Bad version_name in ${local_apk_meta}: '${apk_version_name}'" >&2; exit 1 ;; esac
  case "$apk_version_code" in ""|*[!0-9]*) echo "Bad version_code in ${local_apk_meta}: '${apk_version_code}'" >&2; exit 1 ;; esac

  # A rebuild that skipped the publish script leaves the metadata describing an
  # APK that no longer exists, which would publish the wrong version number.
  local_sha="$(sha256_of "$local_apk")"
  if [ "$local_sha" != "$apk_meta_sha" ]; then
    echo "The APK does not match the metadata beside it, so its version is unknown." >&2
    echo "  apk      ${local_sha}" >&2
    echo "  metadata ${apk_meta_sha}" >&2
    echo "Run npm run publish:android-internal to rebuild and record it." >&2
    exit 1
  fi

  apk_name="MissionGo-Android-${apk_version_name}-${apk_version_code}.apk"
fi

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

if [ "$publish_apk" -eq 1 ]; then
  release_apk="${downloads_dir}/${apk_name}"
  echo "==> Publishing ${apk_name} into ${downloads_dir}"
  remote "sudo mkdir -p '${downloads_dir}' && \
    sudo install -m 0644 '${target}/${local_apk}' '${release_apk}'"

  # Compare digests before the symlink moves: a truncated copy must never become
  # the public download, and an unverified one is worth less than the old build.
  remote_sha="$(remote "sudo sha256sum '${release_apk}'" | awk '{print $1}')"
  if [ "$local_sha" != "$remote_sha" ]; then
    echo "    The published APK does not match the local build, so the link was left alone." >&2
    echo "    local  ${local_sha}" >&2
    echo "    remote ${remote_sha}" >&2
    remote "sudo rm -f '${release_apk}'"
    exit 1
  fi
  echo "    sha256 ${local_sha}"

  # ln -sfn writes a temporary name and mv -T replaces the live link in a single
  # rename, so a visitor never finds the download missing. Without -T, mv would
  # follow the existing link when it happens to name a directory.
  remote "sudo ln -sfn '${release_apk}' '${downloads_dir}/.missiongo-android-latest.apk.tmp' && \
    sudo mv -Tf '${downloads_dir}/.missiongo-android-latest.apk.tmp' '${apk_link}'"
  echo "    ${apk_link} now serves ${apk_version_name} (${apk_version_code})."
fi

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

  if [ "$publish_apk" -eq 1 ]; then
    echo "==> Keeping the newest ${keep} published APKs"
    # Same reasoning as the release directories, and the same protection for the
    # live one. The glob also catches APKs published by hand before the script
    # did it. Sorted by version and then by the epoch version code, so 0.1.10
    # ranks above 0.1.9 rather than below it the way a plain sort would have it.
    remote "live=\$(readlink -f '${apk_link}'); \
      ls -1 '${downloads_dir}'/MissionGo-Android-*.apk 2>/dev/null | sort -rV | tail -n +$((keep + 1)) | \
      while read -r apk; do \
        [ \"\$(readlink -f \"\$apk\")\" = \"\$live\" ] && continue; \
        sudo rm -f \"\$apk\" && echo \"    removed \$(basename \"\$apk\")\"; \
      done"
  fi
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
