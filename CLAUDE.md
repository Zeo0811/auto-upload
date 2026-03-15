# Auto Upload - Social Video Uploader

## Architecture
- **Python API** (`tools.py`): Core functions for login, upload, manage content
- **HTTP Server** (`core/local_server.py`): Port 7788, bridges Python ↔ Chrome Extension
- **Chrome Extension** (`chrome-extension/`): MV3 + CDP automation for DOM interaction
- **MCP Server** (`mcp_server.py`): Exposes tools.py as MCP tools for AI agents

## MCP Server Setup
```json
{
  "mcpServers": {
    "auto-upload": {
      "command": "python3",
      "args": ["/Users/zeoooo/social-video-uploader/mcp_server.py"]
    }
  }
}
```

## Key MCP Tools
- `login_and_wait` — Fast login: returns QR as base64 + HTTP URL immediately
- `upload_and_wait` — Upload + auto-poll until done (no manual polling needed)
- `list_posts`, `edit_post`, `delete_post`, `delete_batch`, `delete_all_posts`

## QR Code Access
- HTTP: `http://127.0.0.1:7788/qr/{account_id}` (open in browser)
- File: `tmp/qr_{account_id}.png`

## Supported Platforms
- xiaohongshu (小红书)
- channels (视频号)
- douyin (抖音) - planned
