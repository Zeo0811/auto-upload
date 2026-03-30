"""后台任务管理：在独立线程运行异步上传任务，支持状态查询"""
import asyncio
from typing import Optional
import json
import logging
import threading
import time
import uuid
from pathlib import Path
from config import TASKS_DIR

logger = logging.getLogger("task_runner")

# 内存任务状态表
_tasks: dict[str, dict] = {}
_lock = threading.Lock()

# 已完成任务在内存中保留的最长时间（秒），超过后自动清理
_TASK_TTL = 7 * 24 * 3600  # 7 天


def _task_file(task_id: str) -> Path:
    return TASKS_DIR / f"{task_id}.json"


def create_task(platform: str, account_id: str) -> str:
    task_id = f"{platform}_{int(time.time())}_{uuid.uuid4().hex[:6]}"
    state = {
        "task_id": task_id,
        "platform": platform,
        "account_id": account_id,
        "status": "queued",
        "progress": 0,
        "post_url": None,
        "error": None,
        "created_at": time.time(),
    }
    with _lock:
        _tasks[task_id] = state
    _persist(task_id)
    _cleanup_old_tasks()
    return task_id


def update_task(task_id: str, **kwargs):
    with _lock:
        if task_id in _tasks:
            _tasks[task_id].update(kwargs)
    _persist(task_id)


def get_task(task_id: str) -> Optional[dict]:
    with _lock:
        if task_id in _tasks:
            return dict(_tasks[task_id])
    # 内存没有则从文件恢复
    f = _task_file(task_id)
    if f.exists():
        try:
            with open(f) as fp:
                state = json.load(fp)
            with _lock:
                _tasks[task_id] = state
            return dict(state)
        except (json.JSONDecodeError, OSError) as e:
            logger.warning("恢复任务 %s 失败: %s", task_id, e)
    return None


def _persist(task_id: str):
    with _lock:
        state = _tasks.get(task_id)
        if state:
            state = dict(state)  # 在锁内拷贝，避免后续文件写入时状态被修改
    if state:
        try:
            with open(_task_file(task_id), "w") as f:
                json.dump(state, f, ensure_ascii=False, indent=2)
        except OSError as e:
            logger.warning("持久化任务 %s 失败: %s", task_id, e)


def _cleanup_old_tasks():
    """清理内存中已完成且超过 TTL 的旧任务"""
    now = time.time()
    to_remove = []
    with _lock:
        for tid, state in _tasks.items():
            if state.get("status") in ("done", "failed"):
                created = state.get("created_at", now)
                if now - created > _TASK_TTL:
                    to_remove.append(tid)
        for tid in to_remove:
            del _tasks[tid]
    if to_remove:
        logger.debug("清理了 %d 个过期任务", len(to_remove))


def run_task_in_background(task_id: str, coro_factory):
    """
    在独立线程里跑一个 asyncio 协程。
    coro_factory: 无参可调用，返回 coroutine
    """
    def _thread():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(coro_factory())
        except Exception:
            logger.exception("后台任务 %s 异常", task_id)
        finally:
            loop.close()

    t = threading.Thread(target=_thread, daemon=True)
    t.start()
