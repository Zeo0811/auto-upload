"""
本地 HTTP 服务，供 Chrome 插件交互。
默认端口 7790，可由 AUTO_UPLOAD_PORT 覆盖；后台线程运行，不依赖 asyncio。
"""

import base64
from typing import Optional
import json
import os
import threading
import tempfile
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from config import BASE_DIR, LOCAL_SERVER_PORT

_server_started = False
_server_lock = threading.Lock()

STATE_DIR = BASE_DIR / "state"
QUEUE_DIR = STATE_DIR / "queue"
LOGIN_STATE_DIR = STATE_DIR / "login_state"
LOGOUT_STATE_DIR = STATE_DIR / "logout_state"
PROGRESS_DIR = STATE_DIR / "progress"
RESULTS_DIR = STATE_DIR / "results"
MANAGE_RESULTS_DIR = STATE_DIR / "manage_results"
FILE_CACHE_DIR = STATE_DIR / "file_cache"

for d in [
    STATE_DIR,
    QUEUE_DIR,
    LOGIN_STATE_DIR,
    LOGOUT_STATE_DIR,
    PROGRESS_DIR,
    RESULTS_DIR,
    MANAGE_RESULTS_DIR,
    FILE_CACHE_DIR,
]:
    d.mkdir(parents=True, exist_ok=True)

_task_lock = threading.Lock()
_login_request_lock = threading.Lock()
_logout_request_lock = threading.Lock()
_progress_lock = threading.Lock()
_results_lock = threading.Lock()
_login_state_lock = threading.Lock()
_logout_state_lock = threading.Lock()
_manage_results_lock = threading.Lock()
_file_cache_lock = threading.Lock()


def _key_path(base: Path, key: str) -> Path:
    return base / f"{key}.json"


def _atomic_write_json(path: Path, data: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=str(path.parent),
        delete=False,
    ) as tmp:
        json.dump(data, tmp, ensure_ascii=False)
        tmp.flush()
        os.fsync(tmp.fileno())
        tmp_path = tmp.name
    os.replace(tmp_path, path)


def _read_json(path: Path) -> Optional[dict]:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _delete_file(path: Path):
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def _pop_json(path: Path) -> Optional[dict]:
    data = _read_json(path)
    if data is not None:
        _delete_file(path)
    return data


def _queue_path(name: str) -> Path:
    return QUEUE_DIR / f"{name}.json"


def _set_queue(name: str, data: dict):
    _atomic_write_json(_queue_path(name), data)


def _get_queue(name: str, consume: bool = False) -> Optional[dict]:
    path = _queue_path(name)
    return _pop_json(path) if consume else _read_json(path)


def _set_keyed_state(base: Path, key: str, data: dict):
    _atomic_write_json(_key_path(base, key), data)


def _get_keyed_state(base: Path, key: str) -> Optional[dict]:
    return _read_json(_key_path(base, key))


def _clear_keyed_state(base: Path, key: str):
    _delete_file(_key_path(base, key))


def get_result(task_id: str) -> Optional[dict]:
    """有结果时返回 dict，否则返回 None"""
    with _results_lock:
        return _get_keyed_state(RESULTS_DIR, task_id)


def get_progress(task_id: str) -> dict:
    """返回当前进度，无记录时返回空 dict"""
    with _progress_lock:
        return _get_keyed_state(PROGRESS_DIR, task_id) or {}


# --------------------------------------------------------------------------- #
# HTTP 处理器
# --------------------------------------------------------------------------- #

class _Handler(BaseHTTPRequestHandler):

    # ---- 公共工具 --------------------------------------------------------- #

    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, data: dict, status: int = 200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def log_message(self, fmt, *args):
        # 静默日志，避免污染终端
        pass

    # ---- OPTIONS preflight ----------------------------------------------- #

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    # ---- GET ------------------------------------------------------------- #

    def do_GET(self):
        path = self.path.split("?")[0]

        # GET /task → 消费一次，之后返回 {}
        if path == "/task":
            with _task_lock:
                task = _get_queue("task", consume=True)
            self._json(task if task else {})
            return

        # GET /login_request → 消费一次，之后返回 {}
        if path == "/login_request":
            with _login_request_lock:
                req = _get_queue("login_request", consume=True)
            self._json(req if req else {})
            return

        # GET /logout_request → 消费一次，之后返回 {}
        if path == "/logout_request":
            with _logout_request_lock:
                req = _get_queue("logout_request", consume=True)
            self._json(req if req else {})
            return

        # GET /health → 用于确认当前监听端口的服务属于哪个项目目录
        if path == "/health":
            self._json({
                "ok": True,
                "base_dir": str(BASE_DIR),
            })
            return

        # GET /file/<task_id> → 流式返回视频文件
        if path.startswith("/file/"):
            task_id = path[len("/file/"):]
            with _file_cache_lock:
                cache = _get_keyed_state(FILE_CACHE_DIR, task_id) or {}
            file_path = cache.get("file_path", "")
            if not file_path or not os.path.isfile(file_path):
                self.send_response(404)
                self._cors_headers()
                self.end_headers()
                return

            size = os.path.getsize(file_path)
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(size))
            self._cors_headers()
            self.end_headers()
            with open(file_path, "rb") as f:
                while chunk := f.read(65536):
                    self.wfile.write(chunk)
            return

        # GET /qr/<account_id> → 返回二维码图片（供浏览器直接打开）
        if path.startswith("/qr/"):
            account_id = path[len("/qr/"):]
            qr_dir = BASE_DIR / "tmp"
            # 尝试多种命名：直接 account_id、manage_ 前缀
            for name in [f"qr_{account_id}.png", f"qr_manage_{account_id}.png"]:
                qr_path = str(qr_dir / name)
                if os.path.isfile(qr_path):
                    size = os.path.getsize(qr_path)
                    self.send_response(200)
                    self.send_header("Content-Type", "image/png")
                    self.send_header("Content-Length", str(size))
                    self.send_header("Cache-Control", "no-cache")
                    self._cors_headers()
                    self.end_headers()
                    with open(qr_path, "rb") as f:
                        self.wfile.write(f.read())
                    return
            self.send_response(404)
            self._cors_headers()
            self.end_headers()
            return

        self.send_response(404)
        self._cors_headers()
        self.end_headers()

    # ---- POST ------------------------------------------------------------ #

    def do_POST(self):
        path = self.path.split("?")[0]
        body = self._read_body()

        # POST /progress
        if path == "/progress":
            task_id = body.get("task_id", "")
            if task_id:
                with _progress_lock:
                    _set_keyed_state(PROGRESS_DIR, task_id, {
                        "progress": body.get("progress", 0),
                        "msg": body.get("msg", ""),
                    })
            self._json({"ok": True})
            return

        # POST /done
        if path == "/done":
            task_id = body.get("task_id", "")
            if task_id:
                with _results_lock:
                    _set_keyed_state(RESULTS_DIR, task_id, {
                        "status": "done",
                        "post_url": body.get("post_url", ""),
                    })
            self._json({"ok": True})
            return

        # POST /fail
        if path == "/fail":
            task_id = body.get("task_id", "")
            if task_id:
                with _results_lock:
                    _set_keyed_state(RESULTS_DIR, task_id, {
                        "status": "fail",
                        "error": body.get("error", "未知错误"),
                    })
            self._json({"ok": True})
            return

        # POST /restore_task — 插件将不匹配平台的任务放回队列
        if path == "/restore_task":
            with _task_lock:
                if _get_queue("task") is None:
                    _set_queue("task", body)
            self._json({"ok": True})
            return

        # POST /restore_login_request — 插件将不匹配平台的请求放回队列
        if path == "/restore_login_request":
            with _login_request_lock:
                if _get_queue("login_request") is None:
                    _set_queue("login_request", body)
            self._json({"ok": True})
            return

        # POST /task_result — 插件回传管理操作结果
        if path == "/task_result":
            task_id = body.get("task_id", "")
            if task_id:
                with _manage_results_lock:
                    _set_keyed_state(MANAGE_RESULTS_DIR, task_id, body)
            self._json({"ok": True})
            return

        # POST /login_status
        if path == "/login_status":
            account_id = body.get("account_id", "")
            status = body.get("status", "")
            if account_id and status:
                state: dict = {"status": status}
                if status in ("qr_required", "qr_refreshed"):
                    qr_base64 = body.get("qr_base64", "")
                    qr_url = body.get("qr_url", "")
                    qr_dir = BASE_DIR / "tmp"
                    qr_dir.mkdir(exist_ok=True)
                    qr_path = str(qr_dir / f"qr_{account_id}.png")
                    saved = False
                    if qr_base64:
                        try:
                            if "," in qr_base64:
                                qr_base64 = qr_base64.split(",", 1)[1]
                            with open(qr_path, "wb") as f:
                                f.write(base64.b64decode(qr_base64))
                            saved = True
                        except Exception:
                            pass
                    if not saved and qr_url:
                        try:
                            import urllib.request
                            urllib.request.urlretrieve(qr_url, qr_path)
                            saved = True
                        except Exception:
                            pass
                    state["qr_path"] = qr_path if saved else ""
                    state["qr_base64"] = body.get("qr_base64", "")
                elif "error" in body:
                    state["error"] = body.get("error", "")
                with _login_state_lock:
                    _set_keyed_state(LOGIN_STATE_DIR, account_id, state)
            self._json({"ok": True})
            return

        # POST /logout_status — 插件回报退出登录结果
        if path == "/logout_status":
            account_id = body.get("account_id", "")
            if account_id:
                with _logout_state_lock:
                    _set_keyed_state(LOGOUT_STATE_DIR, account_id, body)
            self._json({"ok": True})
            return

        self.send_response(404)
        self._cors_headers()
        self.end_headers()

# --------------------------------------------------------------------------- #
# 对外 API
# --------------------------------------------------------------------------- #

def start_server(port: int = LOCAL_SERVER_PORT):
    """启动本地 HTTP 服务（幂等，只启动一次）"""
    global _server_started
    with _server_lock:
        if _server_started:
            return
        try:
            server = HTTPServer(("127.0.0.1", port), _Handler)
            t = threading.Thread(target=server.serve_forever, daemon=True)
            t.start()
            _server_started = True
        except OSError as e:
            if e.errno == 48:  # Address already in use
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as resp:
                        data = json.loads(resp.read().decode("utf-8"))
                    running_base_dir = os.path.realpath(data.get("base_dir", ""))
                    current_base_dir = os.path.realpath(str(BASE_DIR))
                    if running_base_dir == current_base_dir:
                        _server_started = True
                        return
                    raise RuntimeError(
                        f"端口 {port} 已被其他 Auto Upload 实例占用: {data.get('base_dir', 'unknown')}"
                    )
                except RuntimeError:
                    raise
                except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
                    raise RuntimeError(
                        f"端口 {port} 已被其他进程占用，当前项目无法启动本地服务。"
                    )
            raise


def post_task(task_id: str, file_path: str, meta: dict, platform: str = ''):
    """发布一个待处理任务"""
    task = {
            "task_id": task_id,
            "file_path": file_path,
            "meta": meta,
            "platform": platform,
        }
    with _file_cache_lock:
        _set_keyed_state(FILE_CACHE_DIR, task_id, {"file_path": file_path})
    with _task_lock:
        _set_queue("task", task)
    with _progress_lock:
        _set_keyed_state(PROGRESS_DIR, task_id, {"progress": 0, "msg": "等待插件领取任务"})
    with _results_lock:
        _clear_keyed_state(RESULTS_DIR, task_id)


def set_login_request(account_id: str, platform: str = ''):
    """Python 触发一次登录检测"""
    with _login_request_lock:
        _set_queue("login_request", {"account_id": account_id, "platform": platform})


def get_login_state(account_id: str) -> dict:
    """返回当前登录状态，无记录返回 {}"""
    with _login_state_lock:
        return _get_keyed_state(LOGIN_STATE_DIR, account_id) or {}


def clear_login_state(account_id: str):
    """清除登录状态（下次重新检测）"""
    with _login_state_lock:
        _clear_keyed_state(LOGIN_STATE_DIR, account_id)


def set_logout_request(account_id: str, platform: str, domain: str):
    """Python 触发退出登录请求"""
    with _logout_request_lock:
        _set_queue("logout_request", {"account_id": account_id, "platform": platform, "domain": domain})
    with _logout_state_lock:
        _clear_keyed_state(LOGOUT_STATE_DIR, account_id)


def get_logout_state(account_id: str) -> dict:
    """返回退出登录结果，无记录返回 {}"""
    with _logout_state_lock:
        return _get_keyed_state(LOGOUT_STATE_DIR, account_id) or {}


def get_manage_result(task_id: str) -> Optional[dict]:
    """获取管理操作结果，有则返回 dict，否则 None"""
    with _manage_results_lock:
        return _get_keyed_state(MANAGE_RESULTS_DIR, task_id)


def clear_manage_result(task_id: str):
    """清除管理操作结果"""
    with _manage_results_lock:
        _clear_keyed_state(MANAGE_RESULTS_DIR, task_id)
