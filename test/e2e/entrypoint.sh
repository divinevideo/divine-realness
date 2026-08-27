#!/bin/sh
set -e
if [ ! -f /repo/src/index.ts ]; then
  echo "FATAL: /repo/src/index.ts not mounted" >&2
  exit 1
fi
mkdir -p /e2e/worker/src /e2e/worker/migrations
cp -R /repo/src/. /e2e/worker/src/
cp /repo/migrations/*.sql /e2e/worker/migrations/

# Print the gate under test by pattern rather than by line number, so this
# stays accurate when the surrounding file shifts.
echo "== worker source under test =="
sha256sum /e2e/worker/src/index.ts
grep -n "t\[0\] === 'client'" -A 4 /e2e/worker/src/index.ts || \
  echo "WARNING: client-tag gate not found by pattern - has it been removed?"
echo "=============================="

exec "$@"
