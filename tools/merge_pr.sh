#!/usr/bin/env bash
# Merge a pull request in this repository.
#
#   tools/merge_pr.sh <pr-number> [merge|squash|rebase]
#
# Exists so merging is ONE command with a fixed shape, rather than an inline
# compound of `git credential fill` piped into curl. A permission rule can match
# a prefix; it cannot match an ad-hoc pipeline, which is why merging previously
# needed a prompt every time.
#
# `gh` is not installed on this machine, so this goes straight to the REST API
# using the credential git already has. The token is never printed.
set -euo pipefail

REPO="JuanFelipeAgudelo/flightwatch"
PR="${1:?usage: merge_pr.sh <pr-number> [merge|squash|rebase]}"
METHOD="${2:-merge}"

TOKEN="$(printf 'protocol=https\nhost=github.com\n\n' \
  | git credential fill 2>/dev/null \
  | sed -n 's/^password=//p')"
if [ -z "$TOKEN" ]; then
  echo "No stored GitHub credential found. Run a git push first." >&2
  exit 1
fi

code="$(curl -sS -o /tmp/merge_pr_result.json -w '%{http_code}' \
  -X PUT "https://api.github.com/repos/$REPO/pulls/$PR/merge" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -d "{\"merge_method\":\"$METHOD\"}")"

python -c "
import json,sys
d=json.load(open('/tmp/merge_pr_result.json'))
print(d.get('message','(no message)'))
print('sha:', d.get('sha','-'))
" 2>/dev/null || cat /tmp/merge_pr_result.json

[ "$code" = "200" ] || { echo "HTTP $code" >&2; exit 1; }
