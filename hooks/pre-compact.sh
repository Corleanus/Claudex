#!/bin/bash
# Claudex v2 — pre-compact hook wrapper
# Requires: chmod +x pre-compact.sh
DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$DIR/../dist/pre-compact.mjs"
