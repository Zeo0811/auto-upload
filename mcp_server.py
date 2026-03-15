"""
MCP Server 封装 — 让 Claude Code / 支持 MCP 的 Agent 直接调用 tools.py 里的函数。
支持平台：小红书、抖音、视频号等。

启动方式:
  python mcp_server.py

在 Claude Code 的 ~/.claude.json 里添加:
  {
    "mcpServers": {
      "auto-upload": {
        "command": "python3",
        "args": ["/Users/zeoooo/social-video-uploader/mcp_server.py"]
      }
    }
  }
"""
import sys
import os
import time
import base64

sys.path.insert(0, os.path.dirname(__file__))

from mcp.server.fastmcp import FastMCP
import tools

mcp = FastMCP("auto-upload")


# ====================================================================== #
# 快捷工具（减少 AI tool call 轮次，解决二维码传输慢的问题）
# ====================================================================== #

@mcp.tool()
def login_and_wait(platform: str, account_id: str = "test") -> dict:
    """
    一步登录：发起登录并立即返回二维码信息，无需多次 tool call。
    platform: xiaohongshu / channels / douyin
    account_id: 账号标识（默认 test）

    返回值:
    - {"status": "ok"} — 已登录，无需扫码
    - {"status": "qr_required", "qr_url": "http://...", "qr_base64": "data:image/png;base64,..."}
      → 展示 qr_url 给用户在浏览器打开扫码，然后调用 check_login 轮询直到 confirmed
    """
    result = tools.login(platform, account_id)

    if result.get("status") != "qr_required":
        return result

    # 读取 QR 图片，转为 base64 data URL + HTTP URL
    qr_path = result.get("qr_path", "")
    qr_base64 = ""
    if qr_path and os.path.isfile(qr_path):
        with open(qr_path, "rb") as f:
            raw = base64.b64encode(f.read()).decode()
            qr_base64 = f"data:image/png;base64,{raw}"

    return {
        "status": "qr_required",
        "qr_url": f"http://127.0.0.1:7788/qr/{account_id}",
        "qr_base64": qr_base64,
        "qr_path": qr_path,
        "message": "请让用户在浏览器打开 qr_url 扫码登录，然后调用 check_login 轮询状态",
    }


@mcp.tool()
def upload_and_wait(
    platform: str,
    account_id: str,
    source: dict,
    meta: dict,
    timeout_minutes: int = 15,
) -> dict:
    """
    上传视频并等待完成，一次调用搞定（无需手动轮询 get_task_status）。

    source 示例:
      本地文件: {"type": "local", "path": "/path/to/video.mp4"}
      网络URL:  {"type": "url", "url": "https://..."}
      阿里OSS:  {"type": "oss", "bucket": "xxx", "key": "videos/a.mp4"}

    meta 示例:
      {"title": "标题", "description": "描述", "tags": ["标签1"], "cover_path": "/path/to/cover.jpg"}
      可选: "publish_time": "YYYY-MM-DD HH:MM" (定时发布)

    返回:
      成功: {"status": "done", "post_url": "..."}
      失败: {"status": "failed", "error": "..."}
    """
    r = tools.upload_video(platform, account_id, source, meta)
    if r.get("status") == "error":
        return r

    task_id = r["task_id"]
    deadline = time.time() + timeout_minutes * 60

    while time.time() < deadline:
        t = tools.get_task_status(task_id)
        if t["status"] == "done":
            return {"status": "done", "task_id": task_id, "post_url": t.get("post_url", "")}
        if t["status"] == "failed":
            return {"status": "failed", "task_id": task_id, "error": t.get("error", "上传失败")}
        time.sleep(3)

    return {"status": "failed", "task_id": task_id, "error": f"上传超时({timeout_minutes}分钟)"}


# ====================================================================== #
# 基础工具（保持兼容，供需要细粒度控制的场景使用）
# ====================================================================== #

@mcp.tool()
def login(platform: str, account_id: str) -> dict:
    """
    检查并发起登录（基础版，推荐用 login_and_wait）。
    返回 {"status": "ok"} 或 {"status": "qr_required", "qr_path": "..."}
    """
    return tools.login(platform, account_id)


@mcp.tool()
def logout(platform: str, account_id: str) -> dict:
    """
    退出登录，删除本地 session。
    返回 {"status": "ok", "message": "..."}
    """
    return tools.logout(platform, account_id)


@mcp.tool()
def check_login(platform: str, account_id: str) -> dict:
    """
    轮询扫码登录状态。login/login_and_wait 返回 qr_required 后每隔几秒调用一次。
    返回 status: pending | confirmed | qr_refreshed | error
    """
    return tools.check_login(platform, account_id)


@mcp.tool()
def upload_video(platform: str, account_id: str, source: dict, meta: dict) -> dict:
    """
    提交视频上传任务，立即返回 task_id（基础版，推荐用 upload_and_wait）。
    需要手动轮询 get_task_status 获取进度。
    """
    return tools.upload_video(platform, account_id, source, meta)


@mcp.tool()
def get_task_status(task_id: str) -> dict:
    """
    查询上传任务状态。
    返回 status: downloading | uploading | publishing | done | failed
    """
    return tools.get_task_status(task_id)


@mcp.tool()
def batch_upload(platform: str, account_id: str, tasks: list[dict]) -> dict:
    """
    批量上传视频，顺序执行。
    tasks: [{"source": {...}, "meta": {...}}, ...]
    返回 {"results": [{"task_id": "...", "status": "done|failed", ...}, ...]}
    """
    return tools.batch_upload(platform, account_id, tasks)


@mcp.tool()
def list_posts(platform: str, account_id: str, status_filter: str = "") -> dict:
    """
    查询内容列表。
    status_filter: "" (全部) | "published" | "scheduled" | "draft" | "审核中"
    返回 {"status": "ok", "posts": [...]}
    """
    return tools.list_posts(platform, account_id, status_filter)


@mcp.tool()
def edit_post(platform: str, account_id: str, post_id: str, meta: dict) -> dict:
    """
    编辑已有内容。meta 只传需要修改的字段:
    {"title": "...", "description": "...", "tags": [...], "publish_time": "YYYY-MM-DD HH:MM"}
    """
    return tools.edit_post(platform, account_id, post_id, meta)


@mcp.tool()
def delete_post(platform: str, account_id: str, post_id: str) -> dict:
    """
    删除指定内容。
    返回 {"status": "ok"} 或 {"status": "error", "error": "..."}
    """
    return tools.delete_post(platform, account_id, post_id)


@mcp.tool()
def delete_batch(platform: str, account_id: str, post_ids: list[str]) -> dict:
    """
    批量删除多条内容。
    post_ids: ["post_id_1", "post_id_2", ...]
    """
    return tools.delete_batch(platform, account_id, post_ids)


@mcp.tool()
def delete_all_posts(platform: str, account_id: str) -> dict:
    """
    删除该账号下所有内容（危险操作，AI 应先确认用户意图）。
    """
    return tools.delete_all_posts(platform, account_id)


if __name__ == "__main__":
    mcp.run()
