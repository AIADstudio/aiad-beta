#!/bin/bash
# AIAD auto-deploy watcher — run this once and leave it open.
# It watches this folder; when files change (e.g. Claude edits index.html),
# it waits until they've been stable for a few seconds, then commits + pushes,
# which triggers a Vercel deploy. No manual git needed.
#
# To run: double-click this file, OR in Terminal:  ./autodeploy.command
# To stop: press Ctrl+C or close the window.

cd "$(dirname "$0")" || exit 1

echo "🛰  AIAD auto-deploy watching $(pwd)"
echo "    Commits + pushes automatically when files change. Ctrl+C to stop."
echo ""

POLL=3          # seconds between checks
STABLE=2        # consecutive quiet checks required before pushing (avoids mid-edit)
quiet=0

while true; do
  sleep "$POLL"

  # Anything changed?
  if [ -z "$(git status --porcelain)" ]; then
    quiet=0
    continue
  fi

  # Wait until changes have settled (no new edits for STABLE cycles).
  quiet=$((quiet + 1))
  if [ "$quiet" -lt "$STABLE" ]; then
    continue
  fi
  quiet=0

  ts="$(date '+%Y-%m-%d %H:%M:%S')"
  echo "→ changes detected, deploying ($ts)"
  git add -A
  if git commit -m "auto: $ts" >/dev/null 2>&1; then
    if git push origin main >/dev/null 2>&1; then
      echo "  ✓ pushed — Vercel is building"
    else
      echo "  ✗ push failed (check your GitHub auth / network)"
    fi
  else
    echo "  · nothing to commit"
  fi
done
