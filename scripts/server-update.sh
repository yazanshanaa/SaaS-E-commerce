#!/usr/bin/env bash
# Pull the pushed branch onto the production VPS and rebuild the stack.
#
# RUN THIS ON THE SERVER, not on your laptop:
#
#   ssh <user>@<vps>
#   cd /srv/souq-bartaa
#   git fetch --all --prune && git checkout phase-8-11 && git pull --ff-only
#   bash scripts/server-update.sh
#
# WHY IT IS NOT THE GITHUB WORKFLOW. `.github/workflows/deploy.yml` deploys on a green CI run of
# `main`, and this box is checked out to `phase-8-11` — every phase from 8 to 11 lives only on that
# branch and was never merged. Until that merge happens, the workflow watches a branch this server
# does not run, so the update is this script.
#
# WHY IT IS NOT `git pull` INSIDE THE SCRIPT. The pull is above, by hand, on purpose: a script that
# fetches and rebuilds in one step is a script that rebuilds production because someone pressed up-
# arrow. The two halves stay separate so the state being deployed is one you looked at first.

set -euo pipefail

COMPOSE="docker compose -f docker-compose.prod.yml"

echo "── deploying $(git rev-parse --short HEAD) on $(git rev-parse --abbrev-ref HEAD)"

# `build` before `up -d`, and both before anything is torn down: a failed build leaves the OLD
# containers running and serving customers. `up -d` then swaps only what changed.
$COMPOSE build

# The one-shot `migrate` service is declared with `service_completed_successfully`, so web and
# worker cannot start against an unmigrated database — this ordering is in the compose file, not
# in this script's hands.
$COMPOSE up -d --remove-orphans

# HEALTH, not "started". `up -d` returning 0 means the containers were CREATED. `/internal/health`
# is the difference, and it is reachable only inside the compose network because Caddy 404s
# `/internal/*` on every public hostname.
echo "── waiting for web to answer /internal/health"
for attempt in $(seq 1 30); do
  if $COMPOSE exec -T web node -e \
      "fetch('http://127.0.0.1:3000/internal/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    echo "✓ web is healthy"
    $COMPOSE ps
    docker image prune -f
    exit 0
  fi
  sleep 5
done

echo "✗ web never became healthy — the previous images are still on disk, see the rollback below" >&2
$COMPOSE logs --tail=200 web worker >&2
echo >&2
echo "Roll back with:" >&2
echo "  git checkout --detach HEAD~1 && $COMPOSE up -d --build" >&2
exit 1
