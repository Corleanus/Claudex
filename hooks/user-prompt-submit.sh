#!/bin/bash
# Claudex v2 — user-prompt-submit hook wrapper
# Requires: chmod +x user-prompt-submit.sh
DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$DIR/../dist/user-prompt-submit.mjs"
