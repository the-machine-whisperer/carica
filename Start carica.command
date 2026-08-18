#!/bin/bash
# Double-click this file to open carica. macOS runs .command files in Terminal.
#
# It does three things: install what is missing the first time, build the app the first
# time, then open it in your browser. After that it is just a browser tab — everything,
# including starting a run, is a button in the app.
#
# Leave this window open while you are using carica. Closing it stops the app.

cd "$(dirname "$0")" || exit 1

printf '\n  carica — political caricature desk\n\n'

if ! command -v node >/dev/null 2>&1; then
  printf '  Node.js is not installed on this Mac.\n'
  printf '  Install the LTS version from https://nodejs.org and double-click this file again.\n\n'
  read -r -p '  Press return to close. '
  exit 1
fi

if [ ! -d node_modules ]; then
  printf '  First run — installing. This takes a minute and only happens once.\n\n'
  if ! npm install; then
    printf '\n  Install failed. Send the text above to whoever set this up.\n\n'
    read -r -p '  Press return to close. '
    exit 1
  fi
fi

printf '  Opening http://127.0.0.1:4417 — leave this window open.\n'
printf '  Press control-C here when you are finished.\n\n'

exec npm start
