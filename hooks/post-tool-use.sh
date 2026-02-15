#!/bin/bash
# Claudex v2 — post-tool-use hook wrapper
# Requires: chmod +x post-tool-use.sh
DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$DIR/../dist/post-tool-use.mjs"
