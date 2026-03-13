# 环境安装说明

## Python 版本要求

- 核心功能（上传）：Python 3.9+
- MCP Server（`mcp_server.py`）：需要 Python 3.10+，建议用 pyenv 或 Homebrew 安装新版本

## 安装步骤

### 1. 安装 Homebrew（如未安装）
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### 2. 安装 Python 3.11（推荐）
```bash
brew install python@3.11
```

### 3. 安装依赖
```bash
python3.11 -m pip install playwright httpx mcp
python3.11 -m playwright install chromium
```

### 4. 配置环境变量（按需，在 .env 文件里）
```env
# 阿里云 OSS（如用 oss source）
OSS_ACCESS_KEY_ID=xxx
OSS_ACCESS_KEY_SECRET=xxx
OSS_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com

# 飞书（如用 feishu source）
FEISHU_APP_ID=xxx
FEISHU_APP_SECRET=xxx

# Google Sheet（如用 google_sheet source）
GOOGLE_SERVICE_ACCOUNT_JSON=/path/to/service_account.json
```

## 作为 MCP Server 使用

在 `~/.claude.json` 的 `mcpServers` 里添加:
```json
{
  "mcpServers": {
    "social-video-uploader": {
      "command": "python3.11",
      "args": ["/Users/zeoooo/social-video-uploader/mcp_server.py"]
    }
  }
}
```

## 直接作为 Python 模块调用

```python
import sys
sys.path.insert(0, "/Users/zeoooo/social-video-uploader")
import tools

# 1. 登录
result = tools.login("xiaohongshu", "my_account")
# → {"status": "qr_required", "qr_path": "/path/to/qr.png"}  # 自动打开二维码图片

# 2. 轮询扫码（每 3 秒调一次）
import time
while True:
    r = tools.check_login("xiaohongshu", "my_account")
    if r["status"] == "confirmed":
        break
    if r["status"] == "expired":
        result = tools.login("xiaohongshu", "my_account")  # 重新获取二维码
    time.sleep(3)

# 3. 上传视频
r = tools.upload_video(
    platform="xiaohongshu",
    account_id="my_account",
    source={"type": "local", "path": "/Users/zeoooo/Downloads/my_video.mp4"},
    meta={"title": "我的视频", "tags": ["标签1", "标签2"], "description": "描述"},
)
task_id = r["task_id"]

# 4. 轮询进度
while True:
    r = tools.get_task_status(task_id)
    print(r["status"], r.get("progress"), r.get("post_url"))
    if r["status"] in ("done", "failed"):
        break
    time.sleep(10)
```
