"""
Auto Upload — Agent 调用的唯一入口。
支持平台：xiaohongshu（小红书）、channels（视频号）、douyin（抖音）。
所有函数均为同步，返回 dict，结构固定，Agent 可直接解析。
"""
import asyncio
import sys
import os
import time

sys.path.insert(0, os.path.dirname(__file__))

from core.session import load_session, save_session
from core.task_runner import create_task, update_task, get_task, run_task_in_background
from config import TMP_DIR


# ====================================================================== #
# 1. 登录
# ====================================================================== #

def login(platform: str, account_id: str) -> dict:
    """
    检查登录状态。

    返回:
      {"status": "ok"}
        Cookie 有效，直接可以上传。

      {"status": "qr_required", "qr_path": "/path/to/qr.png"}
        需要扫码，qr_path 是二维码图片路径，Agent 应展示给用户。
        扫码后调用 check_login() 轮询。

      {"status": "error", "error": "..."}
    """
    import subprocess
    from core.local_server import start_server, set_login_request, get_login_state, clear_login_state

    start_server()
    clear_login_state(account_id)
    set_login_request(account_id, platform)

    # 打开 Chrome 到 XHS 创作页
    from config import PLATFORM_URLS
    url = PLATFORM_URLS.get(platform, "https://creator.xiaohongshu.com/publish/publish")
    subprocess.run(["open", "-a", "Google Chrome", url], capture_output=True)

    # 等插件报告登录状态（最多 30 秒）
    deadline = time.time() + 90
    while time.time() < deadline:
        time.sleep(1)
        state = get_login_state(account_id)
        if not state:
            continue
        status = state.get('status')
        if status == 'ok':
            save_session(platform, account_id, {'logged_in': True})
            return {'status': 'ok'}
        if status == 'qr_required':
            qr_path = state.get('qr_path', '')
            if qr_path:
                os.system(f"open '{qr_path}'")
            return {'status': 'qr_required', 'qr_path': qr_path}
        if status == 'error':
            return {'status': 'error', 'error': state.get('error', '登录检测失败')}

    return {'status': 'error', 'error': '等待插件响应超时'}


# ====================================================================== #
# 2. 轮询扫码结果
# ====================================================================== #

def check_login(platform: str, account_id: str) -> dict:
    """
    轮询扫码登录状态。在调用 login() 返回 qr_required 后循环调用此函数。

    返回:
      {"status": "pending"}   等待用户扫码
      {"status": "confirmed"} 登录成功
      {"status": "error", "error": "..."}
    """
    from core.local_server import get_login_state
    state = get_login_state(account_id)
    if not state:
        return {'status': 'pending'}
    status = state.get('status')
    if status == 'confirmed':
        save_session(platform, account_id, {'logged_in': True})
        return {'status': 'confirmed'}
    if status == 'ok':
        save_session(platform, account_id, {'logged_in': True})
        return {'status': 'confirmed'}
    if status == 'error':
        return {'status': 'error', 'error': state.get('error', '')}
    return {'status': 'pending'}


# ====================================================================== #
# 3. 提交上传任务
# ====================================================================== #

def upload_video(
    platform: str,
    account_id: str,
    source: dict,
    meta: dict,
) -> dict:
    """
    提交视频上传任务，立即返回 task_id，后台执行上传。

    source 格式:
      {"type": "local",  "path": "/Users/.../video.mp4"}
      {"type": "url",    "url": "https://...", "filename": "可选"}
      {"type": "oss",    "bucket": "...", "key": "...", "endpoint": "可选"}
      {"type": "s3",     "bucket": "...", "key": "...", "region": "可选"}
      {"type": "google_sheet", "sheet_id": "...", "row_id": 1, "video_col": "video_url"}
      {"type": "feishu", "app_token": "...", "table_id": "...", "record_id": "...", "field_name": "视频"}

    meta 格式:
      {"title": "标题", "description": "描述", "tags": ["标签1", "标签2"], "cover_time": 3.0}

    返回:
      {"task_id": "xhs_...", "status": "started"}
      {"status": "error", "error": "..."}
    """
    storage_state = load_session(platform, account_id)
    if storage_state is None:
        return {"status": "error", "error": f"未找到 {platform}/{account_id} 的登录状态，请先调用 login()"}

    task_id = create_task(platform, account_id)

    async def _run_upload():
        try:
            update_task(task_id, status="downloading", progress=5)
            video_path = await _resolve_source(source, task_id)
            update_task(task_id, status="uploading", progress=10)

            from core.local_server import start_server, post_task, get_result, get_progress
            import subprocess
            start_server()
            post_task(task_id, str(video_path), meta, platform)

            # 先等 10 秒，如果插件已在运行的标签页里自动领取了任务就不用再开 Chrome
            for _ in range(10):
                await asyncio.sleep(1)
                if get_progress(task_id).get('progress', 0) > 0:
                    break
            else:
                # 没有标签页在运行，打开 Chrome
                from config import PLATFORM_URLS
                open_url = PLATFORM_URLS.get(platform, "https://creator.xiaohongshu.com/publish/publish")
                subprocess.run(
                    ["open", "-a", "Google Chrome", open_url],
                    capture_output=True
                )

            timeout = 900
            start = time.time()
            while time.time() - start < timeout:
                await asyncio.sleep(2)
                prog = get_progress(task_id)
                if prog.get('progress'):
                    update_task(task_id, progress=prog['progress'],
                                status_msg=prog.get('msg', ''))
                result = get_result(task_id)
                if result:
                    if result['status'] == 'done':
                        _cleanup_tmp(video_path, source)
                        update_task(task_id, status="done", progress=100,
                                    post_url=result.get('post_url'))
                    else:
                        update_task(task_id, status="failed",
                                    error=result.get('error', 'Unknown'))
                    return

            update_task(task_id, status="failed", error="上传超时(15分钟)")
        except Exception as e:
            update_task(task_id, status="failed", error=str(e))

    run_task_in_background(task_id, lambda: _run_upload())
    return {"task_id": task_id, "status": "started"}


# ====================================================================== #
# 4. 查询任务状态
# ====================================================================== #

def get_task_status(task_id: str) -> dict:
    """
    查询上传任务进度。

    返回:
      {"task_id": "...", "status": "downloading|uploading|publishing|done|failed",
       "progress": 0~100, "post_url": "...", "error": "..."}
      {"status": "error", "error": "task 不存在"}
    """
    task = get_task(task_id)
    if task is None:
        return {"status": "error", "error": f"task_id {task_id!r} 不存在"}
    return task


# ====================================================================== #
# 5. 工具函数
# ====================================================================== #

async def _resolve_source(source: dict, task_id: str):
    """根据 source type 实例化对应的 VideoSource 并 resolve"""
    tmp_dir = TMP_DIR / task_id
    tmp_dir.mkdir(exist_ok=True)

    t = source["type"]
    if t == "local":
        from sources.local import LocalSource
        return await LocalSource(source["path"]).resolve(tmp_dir)
    elif t == "url":
        from sources.url import UrlSource
        return await UrlSource(source["url"], source.get("filename")).resolve(tmp_dir)
    elif t == "oss":
        from sources.oss import OssSource
        return await OssSource(source["bucket"], source["key"], source.get("endpoint")).resolve(tmp_dir)
    elif t == "s3":
        from sources.oss import S3Source
        return await S3Source(source["bucket"], source["key"], source.get("region", "us-east-1")).resolve(tmp_dir)
    elif t == "google_sheet":
        from sources.sheet import GoogleSheetSource
        return await GoogleSheetSource(source["sheet_id"], source["row_id"], source.get("video_col", "video_url")).resolve(tmp_dir)
    elif t == "feishu":
        from sources.sheet import FeishuSheetSource
        return await FeishuSheetSource(source["app_token"], source["table_id"], source["record_id"], source.get("field_name", "视频")).resolve(tmp_dir)
    else:
        raise ValueError(f"不支持的 source type: {t}")


def _cleanup_tmp(video_path, source: dict):
    """只清理非本地来源的临时文件"""
    if source["type"] != "local":
        try:
            import shutil
            shutil.rmtree(video_path.parent, ignore_errors=True)
        except Exception:
            pass
