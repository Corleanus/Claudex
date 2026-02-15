#!/bin/bash
# Claudex v2 — session-end hook wrapper
# Requires: chmod +x session-end.sh
DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$DIR/../dist/session-end.mjs"
