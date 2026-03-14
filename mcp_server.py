"""
MCP Server 封装 — 让 Claude Code / 支持 MCP 的 Agent 直接调用 tools.py 里的函数。
支持平台：小红书、抖音、视频号等。

启动方式:
  python mcp_server.py

在 Claude Code 的 ~/.claude.json 里添加:
  {
    "mcpServers": {
      "auto-upload": {
        "command": "python",
        "args": ["/Users/zeoooo/social-video-uploader/mcp_server.py"]
      }
    }
  }
"""
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

from mcp.server.fastmcp import FastMCP
import tools

mcp = FastMCP("auto-upload")


@mcp.tool()
def login(platform: str, account_id: str) -> dict:
    """
    检查并发起登录。
    platform: 平台名，支持 xiaohongshu / douyin / channels
    account_id: 账号标识（自定义，用于区分多账号）

    返回 {"status": "ok"} 或 {"status": "qr_required", "qr_path": "..."}
    qr_required 时需轮询 check_login()，直到返回 confirmed
    """
    return tools.login(platform, account_id)


@mcp.tool()
def check_login(platform: str, account_id: str) -> dict:
    """
    轮询扫码登录状态。login() 返回 qr_required 后每隔几秒调用一次。
    返回 status: pending | scanned | confirmed | expired
    """
    return tools.check_login(platform, account_id)


@mcp.tool()
def upload_video(platform: str, account_id: str, source: dict, meta: dict) -> dict:
    """
    提交视频上传任务，立即返回 task_id。

    source 示例:
      本地文件: {"type": "local", "path": "/Users/xxx/Downloads/video.mp4"}
      网络URL:  {"type": "url", "url": "https://..."}
      阿里OSS:  {"type": "oss", "bucket": "xxx", "key": "videos/a.mp4"}
      飞书表格: {"type": "feishu", "app_token": "xxx", "table_id": "xxx", "record_id": "xxx"}

    meta 示例:
      {"title": "标题", "description": "描述", "tags": ["标签1", "标签2"]}
    """
    return tools.upload_video(platform, account_id, source, meta)


@mcp.tool()
def get_task_status(task_id: str) -> dict:
    """
    查询上传任务状态。
    返回 status: downloading | uploading | publishing | done | failed
    done 时包含 post_url，failed 时包含 error
    """
    return tools.get_task_status(task_id)


@mcp.tool()
def batch_upload(platform: str, account_id: str, tasks: list[dict]) -> dict:
    """
    批量上传视频，顺序执行，每个任务完成后再执行下一个。

    tasks: [{"source": {"type": "local", "path": "..."}, "meta": {"title": "...", ...}}, ...]

    返回 {"results": [{"task_id": "...", "status": "done|failed", ...}, ...]}
    """
    return tools.batch_upload(platform, account_id, tasks)


@mcp.tool()
def list_posts(platform: str, account_id: str, status_filter: str = "") -> dict:
    """
    查询内容列表。
    status_filter: "" (全部) | "published" | "scheduled" | "draft" | "审核中"

    返回 {"status": "ok", "posts": [{"post_id": "...", "title": "...", "status": "...", ...}, ...]}
    """
    return tools.list_posts(platform, account_id, status_filter)


@mcp.tool()
def edit_post(platform: str, account_id: str, post_id: str, meta: dict) -> dict:
    """
    编辑已有内容的标题、描述、标签、定时时间。
    meta: {"title": "...", "description": "...", "tags": [...], "publish_time": "YYYY-MM-DD HH:MM"}
    只传需要修改的字段。
    """
    return tools.edit_post(platform, account_id, post_id, meta)


@mcp.tool()
def delete_post(platform: str, account_id: str, post_id: str) -> dict:
    """
    删除指定内容，直接执行不二次确认。
    返回 {"status": "ok"} 或 {"status": "error", "error": "..."}
    """
    return tools.delete_post(platform, account_id, post_id)


if __name__ == "__main__":
    mcp.run()
