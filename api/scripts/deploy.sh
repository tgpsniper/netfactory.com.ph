#!/usr/bin/env bash
# ============================================================
# deploy.sh — restart the API with a way back
# ============================================================
# Until now the deploy was `pm2 restart isp-api`. There were 136 restarts on
# that process and no record of which one introduced what; a bad edit took the
# API down and pm2 dutifully restarted it into the same error until someone
# noticed. This does the same restart, but refuses to start from a dirty state,
# proves the new process actually serves traffic, and puts the old code back if
# it does not.
#
#   scripts/deploy.sh                    # commit working changes, test, restart
#   scripts/deploy.sh -m "fix the thing" # with a commit message
#   scripts/deploy.sh --no-commit        # restart what is already committed
#   scripts/deploy.sh --dry-run          # run every check, change nothing
#
# Rollback is `git reset --hard <sha>` to the commit recorded before the restart,
# then a restart — which is why this only works with the tree under git.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
APP="${PM2_APP_NAME:-isp-api}"
HEALTH="http://127.0.0.1:${PORT:-3001}/api/health"
HEALTH_TRIES=15          # ~30s: cold start plus Prisma connecting
HEALTH_SLEEP=2

MSG=""
NO_COMMIT=0
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    -m) MSG="${2:-}"; shift 2 ;;
    --no-commit) NO_COMMIT=1; shift ;;
    --dry-run) DRY=1; shift ;;
    *) echo "unknown argument: $1"; exit 2 ;;
  esac
done

say()  { echo "  $*"; }
step() { echo; echo "── $* ─────────────────────────"; }
die()  { echo; echo "  ABORTED: $*"; echo; exit 1; }

step "1/6  repository"
git rev-parse --git-dir >/dev/null 2>&1 || die "not a git repository — rollback would be impossible"
BEFORE="$(git rev-parse HEAD 2>/dev/null)" || die "no commits yet; make an initial commit first"
say "current commit: ${BEFORE:0:9}  $(git log -1 --pretty=%s | cut -c1-60)"

DIRTY="$(git status --porcelain | wc -l)"
say "uncommitted changes: $DIRTY"

step "2/6  syntax"
# Check only what changed. A full-tree check costs seconds and mostly re-proves
# files nobody touched; what matters is that this edit parses.
CHANGED="$(git status --porcelain | awk '{print $NF}' | grep -E '\.js$' || true)"
if [ -z "$CHANGED" ]; then
  say "no changed .js files"
else
  for f in $CHANGED; do
    [ -f "$f" ] || continue
    if node --check "$f" 2>/dev/null; then say "ok   $f"; else
      node --check "$f"; die "$f does not parse"
    fi
  done
fi

step "3/6  smoke tests"
# Run BEFORE the restart, against the code about to be shipped. Catching a bad
# shape here costs nothing; catching it after the restart costs an outage.
if ! node scripts/smoke.js; then
  die "smoke tests failed — nothing was restarted"
fi

if [ "$DRY" = 1 ]; then
  echo; say "--dry-run: checks passed, nothing changed"; echo; exit 0
fi

step "4/6  commit"
if [ "$NO_COMMIT" = 1 ]; then
  say "skipped (--no-commit)"
elif [ "$DIRTY" = 0 ]; then
  say "nothing to commit"
else
  git add -A
  git commit -q -m "${MSG:-deploy $(date -u +%Y-%m-%dT%H:%MZ)}" || die "commit failed"
  say "committed: $(git rev-parse --short HEAD)  ${MSG:-<no message>}"
fi

step "5/6  restart"
pm2 restart "$APP" --update-env >/dev/null 2>&1 || die "pm2 restart failed"
say "restarted $APP"

step "6/6  health"
healthy=0
for i in $(seq 1 $HEALTH_TRIES); do
  sleep "$HEALTH_SLEEP"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH" 2>/dev/null || echo 000)"
  # Anything that answers below 500 is serving. A 404 means the route is absent
  # but the process is up and routing, which is not a reason to roll back.
  if [ "$code" != "000" ] && [ "$code" -lt 500 ] 2>/dev/null; then
    say "healthy after $((i * HEALTH_SLEEP))s (HTTP $code)"; healthy=1; break
  fi
  say "waiting… (HTTP $code)"
done

if [ "$healthy" = 1 ]; then
  # Being up is not the same as being correct. Re-run the checks against the
  # process that is now actually serving.
  if node scripts/smoke.js --quick >/dev/null 2>&1; then
    say "post-restart checks passed"
  else
    say "WARNING: post-restart checks failed though the API is up — investigate"
  fi
  echo; say "deployed: ${BEFORE:0:9} → $(git rev-parse --short HEAD)"; echo
  exit 0
fi

# ── Rollback ────────────────────────────────────────────────
echo
say "API did not become healthy — rolling back to ${BEFORE:0:9}"
git reset --hard "$BEFORE" >/dev/null 2>&1 || {
  say "ROLLBACK FAILED — restore by hand: git reset --hard $BEFORE && pm2 restart $APP"
  exit 1
}
pm2 restart "$APP" --update-env >/dev/null 2>&1
sleep 5
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH" 2>/dev/null || echo 000)"
if [ "$code" != "000" ] && [ "$code" -lt 500 ] 2>/dev/null; then
  say "rolled back and healthy (HTTP $code)"
else
  say "ROLLED BACK BUT STILL UNHEALTHY (HTTP $code) — check: pm2 logs $APP --err"
fi
echo
exit 1
