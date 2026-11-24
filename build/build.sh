#!/bin/bash
# Build the patched Chromium (Linux or macOS).
#   CHROME_SRC    Chromium checkout ("src" directory) with the patches applied (required)
#   OUT_DIR       out directory relative to CHROME_SRC (default: out/Default)
#   DEPOT_TOOLS   depot_tools directory, if it is not already on PATH (optional)
#   JOBS          parallel jobs (optional; autoninja chooses by default)
# Extra arguments are passed to autoninja, e.g. build/build.sh chrome
set -euo pipefail
: "${CHROME_SRC:?set CHROME_SRC to your Chromium src directory}"
OUT_DIR="${OUT_DIR:-out/Default}"
if [ -n "${DEPOT_TOOLS:-}" ]; then export PATH="$DEPOT_TOOLS:$PATH"; fi
export DEPOT_TOOLS_METRICS=0
cd "$CHROME_SRC"
echo "START $(date)"
autoninja ${JOBS:+-j "$JOBS"} -C "$OUT_DIR" "$@"
echo "END $(date)"
