#!/usr/bin/env bash
set -euo pipefail

export ENABLE_SOURCE_LIFECYCLE=true
exec "$(dirname "$0")/enable-recording-retention-production.sh" "$@"
