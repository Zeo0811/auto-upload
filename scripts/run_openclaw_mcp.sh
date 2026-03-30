#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

export AUTO_UPLOAD_PORT="${AUTO_UPLOAD_PORT:-7790}"

cd "${PROJECT_ROOT}"
exec python3.11 "${PROJECT_ROOT}/mcp_server.py"
