#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

PYTHON_BIN="${PYTHON_BIN:-python3.11}"
AUTO_UPLOAD_PORT="${AUTO_UPLOAD_PORT:-7790}"

cd "${PROJECT_ROOT}"

"${PYTHON_BIN}" -m pip install -r "${PROJECT_ROOT}/requirements.txt"
"${PYTHON_BIN}" -m playwright install chromium
chmod +x "${PROJECT_ROOT}/scripts/run_openclaw_mcp.sh"

tmp_batch="$(mktemp)"
trap 'rm -f "${tmp_batch}"' EXIT

cat > "${tmp_batch}" <<EOF
[
  {
    "path": "mcp.servers.auto-upload",
    "value": {
      "command": "${PROJECT_ROOT}/scripts/run_openclaw_mcp.sh",
      "args": [],
      "cwd": "${PROJECT_ROOT}",
      "env": {
        "AUTO_UPLOAD_PORT": "${AUTO_UPLOAD_PORT}"
      }
    }
  }
]
EOF

openclaw config set --batch-file "${tmp_batch}"
openclaw config validate

cat <<EOF
OpenClaw auto-upload 安装完成。

MCP server:
  mcp.servers.auto-upload

项目目录:
  ${PROJECT_ROOT}

端口:
  ${AUTO_UPLOAD_PORT}

给 OpenClaw 的 Agent 指令:
使用 MCP server auto-upload 处理视频上传。
登录时先调用 login_and_wait(platform, account_id)。
如果返回 status=qr_required，先把 channel_message 发回当前会话；
如果当前渠道支持图片，并且返回了 channel_image_data_url，再把二维码图片发给用户；
否则至少把 qr_url 发给用户。
然后轮询 check_login(platform, account_id) 直到 status=confirmed。
上传时优先使用 upload_and_wait。
EOF
