#!/bin/sh
# Mirror of upstream's .github/workflows/dispatch.yml, step for step.
#
# The four behaviours below are load-bearing. They are politeness constraints
# against public systems that belong to somebody else, not tuning knobs:
#
#   --max-queries 8     The county deed database is shared, and a search costs
#                       ~1 s per RESULT ROW against a hard ~180 s server cap.
#   --min-interval-hours 4
#                       reports_collect self-throttles independently of how
#                       often this job fires, so a tighter schedule does not
#                       hammer the city's site.
#   deeds/reports tolerate failure
#                       both are `continue-on-error` upstream. An unreachable
#                       county site must not cost us the dispatch run.
#   build_pulse runs LAST, every run
#                       it folds the other three outputs into pulse.json.
#
# Exit status follows dispatch_collect + build_pulse only, matching upstream.

set -u

STORE="${STORE_DIR:-/store}"
mkdir -p "$STORE"

echo "[collect] store=$STORE upstream=$(git -C /app/upstream rev-parse --short HEAD)"

status=0

echo "[collect] dispatch_collect"
python pipeline/dispatch_collect.py --store "$STORE" || status=1

echo "[collect] deeds_collect (tolerating failure)"
python pipeline/deeds_collect.py --store "$STORE" --max-queries 8 || \
  echo "[collect] deeds_collect failed; continuing"

echo "[collect] reports_collect (tolerating failure)"
python pipeline/reports_collect.py --store "$STORE" --min-interval-hours 4 || \
  echo "[collect] reports_collect failed; continuing"

echo "[collect] build_pulse"
python pipeline/build_pulse.py --store "$STORE" || status=1

echo "[collect] done status=$status"
exit "$status"
