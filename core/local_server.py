"""
本地 HTTP 服务，供 Chrome 插件交互。
端口 7788，后台线程运行，不依赖 asyncio。
"""

import base64
from typing import Optional
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from config import BASE_DIR

_server_started = False
_server_lock = threading.Lock()

# 当前待处理任务
_pending_task: Optional[dict] = None
_pending_task_lock = threading.Lock()

# 进度存储 {task_id: {"progress": int, "msg": str}}
_progress: dict[str, dict] = {}
_progress_lock = threading.Lock()

# 结果存储 {task_id: {"status": "done"|"fail", ...}}
_results: dict[str, dict] = {}
_results_lock = threading.Lock()

# 登录请求 {account_id: str}
_login_request: Optional[dict] = None
_login_request_lock = threading.Lock()

# 登录状态 account_id → {status, qr_path}
_login_state: dict = {}
_login_state_lock = threading.Lock()


def get_result(task_id: str) -> Optional[dict]:
    """有结果时返回 dict，否则返回 None"""
    with _results_lock:
        return _results.get(task_id)


def get_progress(task_id: str) -> dict:
    """返回当前进度，无记录时返回空 dict"""
    with _progress_lock:
        return dict(_progress.get(task_id, {}))


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
            with _pending_task_lock:
                global _pending_task
                task = _pending_task
                _pending_task = None
            self._json(task if task else {})
            return

        # GET /login_request → 消费一次，之后返回 {}
        if path == "/login_request":
            with _login_request_lock:
                global _login_request
                req = _login_request
                _login_request = None
            self._json(req if req else {})
            return

        # GET /file/<task_id> → 流式返回视频文件
        if path.startswith("/file/"):
            task_id = path[len("/file/"):]
            # 从 _results/progress 里找不到 file_path，需要从历史任务数据取
            # 实际 file_path 由 post_task 时缓存
            file_path = _file_cache.get(task_id)
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
                    _progress[task_id] = {
                        "progress": body.get("progress", 0),
                        "msg": body.get("msg", ""),
                    }
            self._json({"ok": True})
            return

        # POST /done
        if path == "/done":
            task_id = body.get("task_id", "")
            if task_id:
                with _results_lock:
                    _results[task_id] = {
                        "status": "done",
                        "post_url": body.get("post_url", ""),
                    }
            self._json({"ok": True})
            return

        # POST /fail
        if path == "/fail":
            task_id = body.get("task_id", "")
            if task_id:
                with _results_lock:
                    _results[task_id] = {
                        "status": "fail",
                        "error": body.get("error", "未知错误"),
                    }
            self._json({"ok": True})
            return

        # POST /login_status
        if path == "/login_status":
            account_id = body.get("account_id", "")
            status = body.get("status", "")
            if account_id and status:
                state: dict = {"status": status}
                if status == "qr_required":
                    qr_base64 = body.get("qr_base64", "")
                    if qr_base64:
                        try:
                            # 去掉 data:image/png;base64, 前缀
                            if "," in qr_base64:
                                qr_base64 = qr_base64.split(",", 1)[1]
                            qr_dir = BASE_DIR / "tmp"
                            qr_dir.mkdir(exist_ok=True)
                            qr_path = str(qr_dir / f"xhs_qr_{account_id}.png")
                            with open(qr_path, "wb") as f:
                                f.write(base64.b64decode(qr_base64))
                            state["qr_path"] = qr_path
                        except Exception:
                            state["qr_path"] = ""
                elif "error" in body:
                    state["error"] = body.get("error", "")
                with _login_state_lock:
                    _login_state[account_id] = state
            self._json({"ok": True})
            return

        self.send_response(404)
        self._cors_headers()
        self.end_headers()


# file_path 缓存，供 GET /file/<task_id> 使用
_file_cache: dict[str, str] = {}


# --------------------------------------------------------------------------- #
# 对外 API
# --------------------------------------------------------------------------- #

def start_server(port: int = 7788):
    """启动本地 HTTP 服务（幂等，只启动一次）"""
    global _server_started
    with _server_lock:
        if _server_started:
            return
        server = HTTPServer(("127.0.0.1", port), _Handler)
        t = threading.Thread(target=server.serve_forever, daemon=True)
        t.start()
        _server_started = True


def post_task(task_id: str, file_path: str, meta: dict):
    """发布一个待处理任务"""
    _file_cache[task_id] = file_path
    with _pending_task_lock:
        global _pending_task
        _pending_task = {
            "task_id": task_id,
            "file_path": file_path,
            "meta": meta,
        }
    with _progress_lock:
        _progress[task_id] = {"progress": 0, "msg": "等待插件领取任务"}
    with _results_lock:
        _results.pop(task_id, None)


def set_login_request(account_id: str):
    """Python 触发一次登录检测"""
    global _login_request
    with _login_request_lock:
        _login_request = {"account_id": account_id}


def get_login_state(account_id: str) -> dict:
    """返回当前登录状态，无记录返回 {}"""
    with _login_state_lock:
        return dict(_login_state.get(account_id, {}))


def clear_login_state(account_id: str):
    """清除登录状态（下次重新检测）"""
    with _login_state_lock:
        _login_state.pop(account_id, None)
