#!/usr/bin/env bash
# Negative control for test/paths-encoding.test.mjs.
#
# A test that has only ever passed is unproven. This plants each half of the 2026-09-09 defect
# back into the source and asserts the suite turns RED, then restores the file. If either
# mutation still passes, the corresponding test is decorative and this script exits non-zero.
set -u

cd "$(dirname "$0")/.." || exit 1
PATHS=lib/paths.mjs
BOARD=lib/board-state.mjs
BACKUP=$(mktemp -d)
cp "$PATHS" "$BACKUP/paths.mjs"
cp "$BOARD" "$BACKUP/board-state.mjs"
restore() {
  cp "$BACKUP/paths.mjs" "$PATHS"
  cp "$BACKUP/board-state.mjs" "$BOARD"
  rm -rf "$BACKUP"
}
trap restore EXIT

pass=0
fail=0

expect_red() { # name
  if node --test test/paths-encoding.test.mjs >/dev/null 2>&1; then
    echo "  FAIL  $1 — the suite still passed with the defect planted"
    fail=$((fail + 1))
  else
    echo "  PASS  $1 — planted defect turns the suite red"
    pass=$((pass + 1))
  fi
}

echo "control A — restore the original '/'-only encoding"
python3 - "$PATHS" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
s = s.replace('return repoPath.replace(/[^a-zA-Z0-9]/g, "-");',
              'return `-${repoPath.split("/").filter(Boolean).join("-")}`;')
open(p, "w").write(s)
PY
expect_red "the pre-fix encoding is caught"
cp "$BACKUP/paths.mjs" "$PATHS"

echo "control B — silence the missing-directory diagnostic"
python3 - "$BOARD" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
s = s.replace('detail: project.claudeProjectDirExists\n        ? null\n        : `No transcript directory at ${project.claudeProjectDir}. The agent list below is UNKNOWN, not empty — ` +',
              'detail: true\n        ? null\n        : `` +')
open(p, "w").write(s)
PY
expect_red "a silenced missing-directory diagnostic is caught"
cp "$BACKUP/board-state.mjs" "$BOARD"

echo "control C — the clean tree must be green"
if node --test test/paths-encoding.test.mjs >/dev/null 2>&1; then
  echo "  PASS  clean tree stays green (the guard does not fire on a correct file)"
  pass=$((pass + 1))
else
  echo "  FAIL  clean tree is red — the control itself is broken"
  fail=$((fail + 1))
fi

echo
echo "paths-encoding controls: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
