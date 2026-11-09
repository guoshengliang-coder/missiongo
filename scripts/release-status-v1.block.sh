# BEGIN RELEASE STATUS
source "$PWD/scripts/release-status.sh"
deploy_finish() {
  local result="$1"
  release_status_finish "$result"
  release_timing_finish "$result"
}
trap 'deploy_finish "$?"' EXIT
release_timing_stage build_images
remote "cd '${target}/deploy' && sudo env MISSIONGO_RELEASE='${commit}' docker compose --env-file '${env_file}' build"
release_status_begin
release_timing_stage build_and_restart
echo "==> Rebuilding and restarting"
# sudo drops the environment, so the value is handed over explicitly. The
# server reports it on /health, which is how a running deployment names itself.
remote "cd '${target}/deploy' && sudo env MISSIONGO_RELEASE='${commit}' docker compose --env-file '${env_file}' up -d --no-build --wait --wait-timeout 180"
release_status_complete
# END RELEASE STATUS
