#!/usr/bin/env bash
#
# Delete the branches whose work is already on the default branch, and list the
# ones that are not so a person decides.
#
#   ./scripts/prune-branches.sh                        # this repo, dry run
#   ./scripts/prune-branches.sh --yes                  # actually delete
#   ./scripts/prune-branches.sh --repo owner/name --yes
#
# Branches accumulate because merging leaves no signal that a branch is done:
# GitHub's delete-on-merge only fires for pull requests, and a fast-forward or a
# direct push is not one. Counting by hand invites deleting the wrong thing, so
# the rule here is narrow: a branch goes only when GitHub reports it as behind
# or identical to the default branch -- every commit on it is already there.
#
# Everything else is printed, never touched. A branch can look unmerged and be
# perfectly redundant -- a pre-rebase tip whose content landed under different
# hashes is the common case -- and only a person can tell that from work that
# was genuinely never finished.

set -euo pipefail

repo=""
confirm=0
include_local=1

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/prune-branches.sh [--repo <owner/name>] [--yes] [--remote-only]

  --repo <owner/name>  Repository to prune. Default: the one this directory belongs to.
  --yes                Delete. Without it nothing is removed and the plan is printed.
  --remote-only        Skip local branches, for a repository not checked out here.
USAGE
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="${2-}"; shift 2 ;;
    --yes) confirm=1; shift ;;
    --remote-only) include_local=0; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1" >&2; usage ;;
  esac
done

command -v gh >/dev/null || { echo "gh is required." >&2; exit 1; }

if [ -z "$repo" ]; then
  repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null)" \
    || { echo "Could not tell which repository this is. Pass --repo owner/name." >&2; exit 1; }
else
  include_local=0
fi

# REST spells it default_branch; a wrong key yields an empty string with a zero
# exit status, so the emptiness is what has to be checked.
default_branch="$(gh api "repos/${repo}" --jq .default_branch 2>/dev/null)"
[ -n "$default_branch" ] || { echo "Could not read the default branch of ${repo}." >&2; exit 1; }

echo "Repository:      ${repo}"
echo "Default branch:  ${default_branch}"
echo

# A branch with an open pull request is never deleted, whatever its state:
# deleting it closes the pull request, which is someone's open thread.
open_pr_heads="$(gh pr list --repo "$repo" --state open --limit 200 --json headRefName --jq '.[].headRefName' 2>/dev/null || true)"
has_open_pr() {
  printf '%s\n' "$open_pr_heads" | grep -Fxq "$1"
}

branches=()
while IFS= read -r name; do
  [ -n "$name" ] || continue
  [ "$name" = "$default_branch" ] || branches+=("$name")
done <<EOF
$(gh api "repos/${repo}/branches?per_page=100" --paginate --jq '.[].name')
EOF

[ "${#branches[@]}" -gt 0 ] || { echo "No branches besides ${default_branch}."; exit 0; }
echo "Comparing ${#branches[@]} branches against ${default_branch}..."

merged=()
keep=()
for name in "${branches[@]}"; do
  if has_open_pr "$name"; then
    keep+=("${name}|open pull request")
    continue
  fi
  # "behind" means every commit on the branch is already on the default branch;
  # "identical" means it points at the same commit.
  status="$(gh api "repos/${repo}/compare/${default_branch}...${name}" --jq .status 2>/dev/null || echo unknown)"
  case "$status" in
    behind|identical) merged+=("$name") ;;
    ahead) keep+=("${name}|${status} — has commits not on ${default_branch}") ;;
    diverged) keep+=("${name}|${status} — may be a pre-rebase tip; check before deleting") ;;
    *) keep+=("${name}|could not be compared") ;;
  esac
done

echo
if [ "${#keep[@]}" -gt 0 ]; then
  echo "Keeping ${#keep[@]} (nothing below is touched):"
  for entry in "${keep[@]}"; do
    printf '  %-52s %s\n' "${entry%%|*}" "${entry#*|}"
  done
  echo
fi

if [ "${#merged[@]}" -eq 0 ]; then
  echo "Nothing to delete."
  exit 0
fi

echo "Already on ${default_branch} — ${#merged[@]} branch(es):"
for name in "${merged[@]}"; do echo "  ${name}"; done
echo

if [ "$confirm" -eq 0 ]; then
  echo "Dry run. Re-run with --yes to delete these."
  exit 0
fi

# Local branches first: git refuses to delete one that a worktree has checked
# out, which is the guard that keeps a live session's branch safe.
if [ "$include_local" -eq 1 ] && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  for name in "${merged[@]}"; do
    git show-ref --verify --quiet "refs/heads/${name}" || continue
    if git branch -d "$name" >/dev/null 2>&1; then
      echo "  deleted locally   ${name}"
    else
      echo "  kept locally      ${name} (checked out, or git considers it unmerged)"
    fi
  done
fi

for name in "${merged[@]}"; do
  if gh api -X DELETE "repos/${repo}/git/refs/heads/${name}" >/dev/null 2>&1; then
    echo "  deleted on remote ${name}"
  else
    echo "  FAILED on remote  ${name}"
  fi
done

echo
echo "Done. ${#keep[@]} branch(es) left for you to look at."
