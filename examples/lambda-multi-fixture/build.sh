#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$here/dist"
( cd "$here" && zip -q -j dist/a.zip handler_a.py && zip -q -j dist/b.zip handler_b.py )
echo "built a.zip + b.zip"
