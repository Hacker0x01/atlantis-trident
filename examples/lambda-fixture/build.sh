#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$here/dist"
( cd "$here" && zip -q -j dist/lambda.zip handler.py )
echo "built $here/dist/lambda.zip"
