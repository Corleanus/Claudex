#!/bin/bash
# Claudex v2 — pre-flush hook wrapper
# Requires: chmod +x pre-flush.sh
DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$DIR/../dist/pre-flush.mjs"
