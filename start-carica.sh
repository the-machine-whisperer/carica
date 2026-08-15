#!/bin/bash
# Linux equivalent of "Start carica.command" — run it, or mark it executable and
# double-click it from a file manager.

cd "$(dirname "$0")" || exit 1

printf '\n  carica — political caricature desk\n\n'

if ! command -v node >/dev/null 2>&1; then
  printf '  Node.js is not installed. Install Node 22 or newer, then run this again.\n\n'
  exit 1
fi

if [ ! -d node_modules ]; then
  printf '  First run — installing. This takes a minute and only happens once.\n\n'
  npm install || exit 1
fi

printf '  Opening http://127.0.0.1:4317 — leave this window open.\n\n'
exec npm start
