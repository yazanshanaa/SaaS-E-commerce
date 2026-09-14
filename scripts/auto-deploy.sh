#!/usr/bin/env bash
# Pull-to-deploy for the production VPS (2026-09-13).
#
# THE PROBLEM THIS SOLVES. Deploying meant a person opening the hPanel web console, typing a
# git checkout and running scripts/server-update.sh by hand. The GitHub workflow in
# .github/workflows/deploy.yml needs an SSH key INTO the box, which was never set up. So every
# release was a manual session on a one-time console link — the exact friction the owner reported.
#
# THE MECHANISM. The server already holds a read-only deploy key for the repository. A cron entry
# runs this script every few minutes; it fetches the `production` branch and, ONLY when the remote
# tip differs from what is checked out, does exactly what a person would have done:
#
#     git checkout --detach <new tip>  →  docker compose build  →  up -d  →  health check
#
# Pushing to `production` is therefore the whole release procedure. Nothing reaches the box on any
# other branch, no secret leaves the box, and a failed build leaves the OLD containers serving.
#
# INSTALL ONCE (as the app user, in the checkout):
#
#     chmod +x scripts/auto-deploy.sh
#     ( crontab -l 2>/dev/null; echo '*/3 * * * * /srv/souq-bartaa/scripts/auto-deploy.sh >> /srv/souq-bartaa/.deploy.log 2>&1' ) | crontab -
#
# ROLL BACK by pushing the previous commit to `production` (or `git checkout --detach <sha> &&
# bash scripts/server-update.sh` on the box). The log is /srv/souq-bartaa/.deploy.log.

set -euo pipefail

BRANCH="${DEPLOY_BRANCH:-production}"
REPO_DIR="${DEPLOY_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LOCK="$REPO_DIR/.deploy.lock"

cd "$REPO_DIR"

# One deploy at a time. `flock` is in util-linux, present on every Ubuntu image.
exec 9>"$LOCK"
if ! flock -n 9; then
  exit 0
fi

git fetch --quiet origin "$BRANCH" --prune

current="$(git rev-parse HEAD)"
target="$(git rev-parse "origin/$BRANCH")"

if [[ "$current" == "$target" ]]; then
  exit 0
fi

echo "── $(date -Is) deploying ${target:0:8} (was ${current:0:8}) from origin/$BRANCH"

# Detached, so a hand-run `git pull` in the checkout later can never fast-forward the wrong branch.
git checkout --quiet --detach "$target"

if bash scripts/server-update.sh; then
  echo "── $(date -Is) ✓ ${target:0:8} is live"
else
  echo "── $(date -Is) ✗ ${target:0:8} failed; previous containers still serving. Reverting checkout."
  git checkout --quiet --detach "$current"
  exit 1
fi
