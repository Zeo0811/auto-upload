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

from core.session import load_session, save_session, delete_session
from core.task_runner import create_task, update_task, get_task, run_task_in_background
from config import TMP_DIR, PLATFORM_MANAGE_URLS


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
            return {'status': 'qr_required', 'qr_path': qr_path}
        if status == 'error':
            return {'status': 'error', 'error': state.get('error', '登录检测失败')}

    return {'status': 'error', 'error': '等待插件响应超时'}


# ====================================================================== #
# 1.5 退出登录
# ====================================================================== #

PLATFORM_COOKIE_DOMAINS = {
    "xiaohongshu": "xiaohongshu.com",
    "channels": "qq.com",
    "douyin": "douyin.com",
}

def logout(platform: str, account_id: str) -> dict:
    """
    退出登录：清除浏览器 cookie + 删除本地 session。

    返回:
      {"status": "ok", "message": "已退出登录", "cookies_removed": N}
      {"status": "ok", "message": "未找到登录状态，无需退出"}
      {"status": "error", "error": "..."}
    """
    import subprocess
    from core.local_server import start_server, set_logout_request, get_logout_state

    # 删除本地 session
    session = load_session(platform, account_id)
    delete_session(platform, account_id)

    # 通过插件清除浏览器 cookie
    domain = PLATFORM_COOKIE_DOMAINS.get(platform, "")
    if not domain:
        return {"status": "ok", "message": f"{platform}/{account_id} 已退出登录（仅清除本地 session）"}

    start_server()

    # 先打开平台页面，等 content.js 加载
    from config import PLATFORM_URLS
    url = PLATFORM_URLS.get(platform, "")
    if url:
        subprocess.run(["open", "-a", "Google Chrome", url], capture_output=True)
    time.sleep(5)  # 等标签页加载 + content.js 注入

    set_logout_request(account_id, platform, domain)

    # 等待插件清除 cookie 完成（最多 30 秒）
    deadline = time.time() + 30
    last_set_time = time.time()
    while time.time() < deadline:
        time.sleep(1)
        # 每 5 秒重新设置一次请求，防止被空消费
        if time.time() - last_set_time > 5:
            state = get_logout_state(account_id)
            if not state:
                set_logout_request(account_id, platform, domain)
                last_set_time = time.time()
        state = get_logout_state(account_id)
        if not state:
            continue
        if state.get("status") == "ok":
            return {
                "status": "ok",
                "message": f"{platform}/{account_id} 已退出登录",
                "cookies_removed": state.get("removed", 0),
            }
        if state.get("status") == "error":
            return {"status": "error", "error": f"清除 cookie 失败: {state.get('error', '')}"}

    # 超时但本地 session 已删
    return {"status": "ok", "message": f"{platform}/{account_id} 已清除本地 session，浏览器 cookie 清除超时（插件可能未运行）"}


# ====================================================================== #
# 2. 轮询扫码结果
# ====================================================================== #

_qr_refresh_count: dict = {}  # account_id → 已刷新次数
MAX_QR_REFRESH = 3

def check_login(platform: str, account_id: str) -> dict:
    """
    轮询扫码登录状态。在调用 login() 返回 qr_required 后循环调用此函数。

    返回:
      {"status": "pending"}    等待用户扫码
      {"status": "confirmed"}  登录成功
      {"status": "qr_refreshed", "qr_path": "..."}  二维码已自动刷新，需重新展示给用户
      {"status": "error", "error": "..."}
    """
    import subprocess
    from core.local_server import get_login_state, clear_login_state, set_login_request

    state = get_login_state(account_id)
    if not state:
        return {'status': 'pending'}
    status = state.get('status')
    if status == 'confirmed':
        save_session(platform, account_id, {'logged_in': True})
        _qr_refresh_count.pop(account_id, None)
        return {'status': 'confirmed'}
    if status == 'ok':
        save_session(platform, account_id, {'logged_in': True})
        _qr_refresh_count.pop(account_id, None)
        return {'status': 'confirmed'}
    if status == 'error':
        error_msg = state.get('error', '')
        # 二维码超时：自动刷新页面重新获取
        if error_msg == 'qr_timeout':
            count = _qr_refresh_count.get(account_id, 0)
            if count < MAX_QR_REFRESH:
                _qr_refresh_count[account_id] = count + 1
                clear_login_state(account_id)
                set_login_request(account_id, platform)
                # 刷新浏览器标签页
                from config import PLATFORM_URLS
                url = PLATFORM_URLS.get(platform, "")
                if url:
                    subprocess.run(["open", "-a", "Google Chrome", url], capture_output=True)
                # 等待插件重新获取二维码
                deadline = time.time() + 30
                while time.time() < deadline:
                    time.sleep(1)
                    new_state = get_login_state(account_id)
                    if not new_state:
                        continue
                    new_status = new_state.get('status')
                    if new_status == 'qr_required':
                        qr_path = new_state.get('qr_path', '')
                        return {
                            'status': 'qr_refreshed',
                            'qr_path': qr_path,
                        }
                    if new_status == 'ok':
                        save_session(platform, account_id, {'logged_in': True})
                        _qr_refresh_count.pop(account_id, None)
                        return {'status': 'confirmed'}
                # 刷新失败
                return {'status': 'error', 'error': f'二维码刷新失败（第 {count + 1} 次）'}
            else:
                _qr_refresh_count.pop(account_id, None)
                return {'status': 'error', 'error': f'二维码超时，已重试 {MAX_QR_REFRESH} 次'}
        return {'status': 'error', 'error': error_msg}
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
# 5. 批量上传
# ====================================================================== #

def batch_upload(
    platform: str,
    account_id: str,
    tasks: list[dict],
) -> dict:
    """
    批量上传视频，顺序执行。每个任务完成（done/failed）后才执行下一个。

    tasks: [{"source": {...}, "meta": {...}}, ...]

    返回:
      {"results": [{"task_id": "...", "status": "done|failed", ...}, ...]}
    """
    results = []
    for i, t in enumerate(tasks):
        r = upload_video(platform, account_id, t["source"], t["meta"])
        if r.get("status") == "error":
            results.append(r)
            continue
        task_id = r["task_id"]
        # 等待任务完成
        while True:
            time.sleep(3)
            status = get_task_status(task_id)
            if status.get("status") in ("done", "failed"):
                results.append(status)
                break
    return {"results": results}


# ====================================================================== #
# 6. 内容管理 — 列表查询
# ====================================================================== #

def _submit_manage_task(platform: str, account_id: str, manage_type: str, params: dict, timeout: int = 300) -> dict:
    """提交管理任务到插件并等待结果的通用函数。自动处理登录。"""
    import subprocess
    from core.local_server import start_server, post_task, get_manage_result, clear_manage_result, get_progress

    start_server()

    # 先确保已登录（session 存在不代表 cookie 有效，但至少要有 session）
    storage_state = load_session(platform, account_id)
    if storage_state is None:
        # 没有 session，走完整登录流程
        login_result = login(platform, account_id)
        if login_result.get("status") == "qr_required":
            # 需要扫码，等待登录完成
            for _ in range(90):
                time.sleep(2)
                r = check_login(platform, account_id)
                if r.get("status") == "confirmed":
                    break
                if r.get("status") in ("expired", "error"):
                    return {"status": "error", "error": f"登录失败: {r}"}
            else:
                return {"status": "error", "error": "等待扫码超时"}
        elif login_result.get("status") not in ("ok", "confirmed"):
            return {"status": "error", "error": f"登录失败: {login_result}"}

    task_id = create_task(platform, account_id)
    clear_manage_result(task_id)

    # 打开管理页（先开页面，等插件加载后再投递任务）
    manage_url = PLATFORM_MANAGE_URLS.get(platform)
    if manage_url:
        subprocess.run(["open", "-a", "Google Chrome", manage_url], capture_output=True)

    # 等页面加载 + 插件初始化
    time.sleep(4)

    # 发布管理任务（复用 post_task，file_path 为空，通过 meta 传递管理参数）
    manage_meta = {"_manage_type": manage_type, **params}
    post_task(task_id, "", manage_meta, platform)

    # 等待插件回传结果（同时监听登录请求，以防 cookie 过期）
    from core.local_server import get_login_state, clear_login_state
    from config import PLATFORM_URLS
    manage_account = f"manage_{platform}"
    login_handled = False

    start = time.time()
    while time.time() - start < timeout:
        time.sleep(2)

        # 检查管理操作结果
        result = get_manage_result(task_id)
        if result:
            clear_manage_result(task_id)

            return result

        # 检查是否插件触发了登录（cookie 过期时）
        if not login_handled:
            state = get_login_state(manage_account)
            if state:
                status = state.get('status')
                if status == 'qr_required':
                    qr_path = state.get('qr_path', '')
                    print(f"[管理操作] 需要重新登录，请扫码: {qr_path}")
                elif status in ('ok', 'confirmed'):
                    save_session(platform, account_id, {'logged_in': True})
                    clear_login_state(manage_account)
                    login_handled = True
                    print(f"[管理操作] 登录成功，继续执行...")

    return {"status": "error", "error": "管理操作超时"}


def list_posts(platform: str, account_id: str, status_filter: str = "") -> dict:
    """
    查询已发布/未发布/定时待发的内容列表。

    status_filter: ""(全部) | "published" | "scheduled" | "draft" | "审核中"

    返回:
      {"status": "ok", "posts": [{"post_id": "...", "title": "...", "status": "...", ...}, ...]}
    """
    return _submit_manage_task(platform, account_id, "list_posts", {
        "status_filter": status_filter,
    })


def edit_post(platform: str, account_id: str, post_id: str, meta: dict) -> dict:
    """
    编辑已有内容。

    meta: {"title": "...", "description": "...", "tags": [...], "publish_time": "YYYY-MM-DD HH:MM"}
    只传需要修改的字段即可。

    返回:
      {"status": "ok"} 或 {"status": "error", "error": "..."}
    """
    return _submit_manage_task(platform, account_id, "edit_post", {
        "post_id": post_id,
        "meta": meta,
    })


def delete_post(platform: str, account_id: str, post_id: str) -> dict:
    """
    删除指定内容。

    返回:
      {"status": "ok"} 或 {"status": "error", "error": "..."}
    """
    return _submit_manage_task(platform, account_id, "delete_post", {
        "post_id": post_id,
    })


def delete_all_posts(platform: str, account_id: str) -> dict:
    """
    删除当前账号所有内容（一次 Chrome 会话批量处理）。

    返回:
      {"status": "ok", "deleted": N, "failed": M} 或 {"status": "error", "error": "..."}
    """
    return _submit_manage_task(platform, account_id, "delete_all_posts", {}, timeout=600)


def delete_batch(platform: str, account_id: str, post_ids: list) -> dict:
    """
    按 post_id 列表批量删除（一次 Chrome 会话处理完再关标签）。
    小红书：post_ids 为 noteId 列表。
    视频号：传空列表会调用 delete_all_posts。

    返回:
      {"status": "ok", "deleted": N, "failed": M, "not_found": K}
    """
    if platform == "xiaohongshu":
        return _submit_manage_task(platform, account_id, "delete_batch", {
            "post_ids": post_ids,
        }, timeout=600)
    else:
        # 视频号用 delete_all_posts（按索引删，不用 ID）
        return _submit_manage_task(platform, account_id, "delete_all_posts", {}, timeout=600)


# ====================================================================== #
# 7. 工具函数
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
