#!/usr/bin/env bash
# Wait until the master `validate` run for a release tag's commit has finished, so the
# release builds restore the caches its release-cache jobs save (see release.yml's
# `warm-caches` job for why).
#
#   REPO=owner/name GH_TOKEN=… scripts/wait-for-warm-caches.sh v1.2.3
#
# Never fails the release: no run for the commit, a failed or cancelled run, or the
# time limit all end the wait with a notice, and the build compiles what it must.
set -euo pipefail

tag="${1:?usage: wait-for-warm-caches.sh <tag>}"
repo="${REPO:?REPO is required}"
limit_min="${WAIT_LIMIT_MINUTES:-75}"
appear_min="${WAIT_APPEAR_MINUTES:-3}"
poll="${WAIT_POLL_SECONDS:-30}"

if ! sha="$(gh api "repos/$repo/commits/$tag" --jq .sha)"; then
  echo "::notice::Could not resolve $tag to a commit; building without waiting."
  exit 0
fi
echo "Release $tag is commit $sha"

runs() {
  gh run list --repo "$repo" --workflow validate.yml --event push --commit "$sha" \
    --json databaseId,status,conclusion,url \
    --jq '.[] | "\(.databaseId) \(.status) \(.conclusion) \(.url)"'
}

start=$SECONDS
while :; do
  elapsed=$(( (SECONDS - start) / 60 ))
  list="$(runs || true)"
  if [[ -z "$list" ]]; then
    # The push that carried the tag usually carried the commit too; its run can take
    # a moment to appear. A tag on an older commit has nothing to wait for.
    if (( elapsed >= appear_min )); then
      echo "::notice::No master validate run for $sha; building without waiting."
      exit 0
    fi
  elif ! grep -qv ' completed ' <<<"$list"; then
    echo "Validate run(s) for $sha finished:"
    echo "$list"
    grep -q ' completed success ' <<<"$list" ||
      echo "::notice::The validate run did not succeed; any cache it saved is still used."
    exit 0
  fi
  if (( elapsed >= limit_min )); then
    echo "::warning::Validate for $sha still running after ${limit_min} min; building without its caches."
    exit 0
  fi
  echo "[${elapsed} min] waiting for validate on $sha: ${list:-not started yet}"
  sleep "$poll"
done
