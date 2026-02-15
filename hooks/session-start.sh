#!/bin/bash
# Claudex v2 — session-start hook wrapper
# Requires: chmod +x session-start.sh
DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$DIR/../dist/session-start.mjs"
