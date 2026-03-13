"""
Agent 调用的唯一入口。
所有函数均为同步，返回 dict，结构固定，Agent 可直接解析。
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from core.browser import new_context, close_browser
from core.session import load_session, save_session, delete_session
from core.task_runner import create_task, update_task, get_task, run_task_in_background
from config import TMP_DIR

# 平台映射
_PLATFORM_MAP = {
    "xiaohongshu": "platforms.xiaohongshu.XiaohongshuPlatform",
}

# 登录中的 context 缓存 {platform_account_id: BrowserContext}
_login_contexts: dict[str, object] = {}


def _get_platform_class(platform: str):
    import importlib
    if platform not in _PLATFORM_MAP:
        raise ValueError(f"不支持的平台: {platform}，可选: {list(_PLATFORM_MAP.keys())}")
    module_path, class_name = _PLATFORM_MAP[platform].rsplit(".", 1)
    module = importlib.import_module(module_path)
    return getattr(module, class_name)


def _run(coro):
    """在当前线程运行协程，兼容已有事件循环的情况"""
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor() as pool:
                future = pool.submit(asyncio.run, coro)
                return future.result()
        else:
            return loop.run_until_complete(coro)
    except RuntimeError:
        return asyncio.run(coro)


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
    key = f"{platform}_{account_id}"

    async def _do():
        PlatformClass = _get_platform_class(platform)
        storage_state = load_session(platform, account_id)
        context = await new_context(storage_state)
        instance = PlatformClass(context, account_id)

        if await instance.is_logged_in():
            # 刷新保存 Cookie
            state = await context.storage_state()
            save_session(platform, account_id, state)
            await context.close()
            return {"status": "ok"}

        # 需要扫码登录
        _login_contexts[key] = (context, instance)
        qr_path = await instance.get_qr_code()

        # Mac 本地自动打开图片预览
        os.system(f"open '{qr_path}'")

        return {"status": "qr_required", "qr_path": qr_path}

    try:
        return _run(_do())
    except Exception as e:
        return {"status": "error", "error": str(e)}


# ====================================================================== #
# 2. 轮询扫码结果
# ====================================================================== #

def check_login(platform: str, account_id: str) -> dict:
    """
    轮询扫码登录状态。在调用 login() 返回 qr_required 后循环调用此函数。

    返回:
      {"status": "pending"}   等待用户扫码
      {"status": "scanned"}   已扫码，等待确认
      {"status": "confirmed"} 登录成功
      {"status": "expired"}   二维码已过期，需重新调 login()
      {"status": "error", "error": "..."}
    """
    key = f"{platform}_{account_id}"

    async def _do():
        if key not in _login_contexts:
            return {"status": "error", "error": "没有进行中的登录流程，请先调用 login()"}

        context, instance = _login_contexts[key]
        status = await instance.check_qr_status()

        if status == "confirmed":
            state = await context.storage_state()
            save_session(platform, account_id, state)
            del _login_contexts[key]
            await context.close()

        return {"status": status}

    try:
        return _run(_do())
    except Exception as e:
        return {"status": "error", "error": str(e)}


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

            # 解析 source
            video_path = await _resolve_source(source, task_id)

            update_task(task_id, status="uploading", progress=15)

            PlatformClass = _get_platform_class(platform)
            context = await new_context(storage_state)
            instance = PlatformClass(context, account_id)

            def on_progress(pct, msg):
                update_task(task_id, progress=pct, status_msg=msg)

            post_url = await instance.upload(video_path, meta, on_progress=on_progress)

            # 刷新 Cookie
            state = await context.storage_state()
            save_session(platform, account_id, state)
            await context.close()

            # 清理临时文件
            _cleanup_tmp(video_path, source)

            update_task(task_id, status="done", progress=100, post_url=post_url)

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
