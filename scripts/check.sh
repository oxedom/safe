#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

for file in extension/content/*.js extension/background/*.js extension/offscreen/*.js \
  extension/offscreen/detectors/*.js extension/popup/*.js extension/shared/*.js test/*.js; do
  node --check "$file"
done
python3 -m py_compile test/*.py
for file in scripts/*.sh; do
  bash -n "$file"
done
echo 'JavaScript, Python and shell syntax OK'
